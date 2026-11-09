// The exact-reason matcher. A scenario asks "what did peblish do with this activity?" and the
// answer is read from the rows peblish wrote: inbox_raw for what arrived, deliveries for what
// was sent. An expectation names the state and, for a skip, the reason as a SkipReason, so a
// typo fails typecheck and the comparison is equality, never "contains".
//
//   await expectInbound(sql, { since, actor, type: 'Announce', contains: postApId },
//                       { state: 'skipped', reason: 'announce.bare_iri', detail: boostIri })
//
// A mismatch throws a Mismatch whose message ends in `got [<outcome>]`. A scenario that records
// a documented peer defect gives that exact bracketed outcome as its `known` signature, so a
// failure that differs is a `fail`, and a pass says the defect is fixed (lab.ts `recorder`).
import type { SkipReason } from '@peblish/federation/inbound/reasons';
import type postgres from 'postgres';
import { sleep } from './lab.ts';

export type Sql = postgres.Sql;

export type InboxExpectation =
  | { state: 'applied' }
  /** `detail` is what follows the reason in `inbox_raw.error` (a missing object's ap_id). */
  | { state: 'skipped'; reason: SkipReason; detail?: string }
  | { state: 'failed'; error: string };

export type InboxQuery = {
  /** Rows received at or after this time. */
  since: Date;
  actor?: string;
  type?: string;
  /** Text the body must contain (the object's id). PHP peers escape slashes (`https:\\/\\/`); the body is compared unescaped. */
  contains?: string;
};

export type InboxRow = {
  id: string;
  activityId: string | null;
  type: string | null;
  actor: string | null;
  state: string;
  error: string | null;
};

export class Mismatch extends Error {
  override readonly name = 'Mismatch';
}

/** `skipped announce.bare_iri <iri>`, `applied`, `failed <error>`: how an outcome reads in a message. */
export function outcomeText(row: Pick<InboxRow, 'state' | 'error'>): string {
  return row.error ? `${row.state} ${row.error}` : row.state;
}

export function expectedText(expected: InboxExpectation): string {
  if (expected.state === 'applied') return 'applied';
  if (expected.state === 'failed') return `failed ${expected.error}`;
  return `skipped ${expected.detail ? `${expected.reason} ${expected.detail}` : expected.reason}`;
}

const describeQuery = (query: InboxQuery) =>
  [query.type, query.actor && `from ${query.actor}`, query.contains && `about ${query.contains}`].filter(Boolean).join(' ') ||
  'any activity';

const listRows = (rows: readonly InboxRow[]) =>
  rows.map((row) => `${row.type ?? '?'} ${row.activityId ?? '?'} [${outcomeText(row)}]`).join('; ');

/**
 * Compares settled rows with an expectation. Exactly one row must match the query: none, or
 * several, fails and lists what was found. Pure, so the unit tests need no database.
 */
export function matchInbound(rows: readonly InboxRow[], query: InboxQuery, expected: InboxExpectation): InboxRow {
  if (rows.length === 0) throw new Mismatch(`no inbox row for ${describeQuery(query)}; expected [${expectedText(expected)}]`);
  if (rows.length > 1) throw new Mismatch(`${rows.length} inbox rows for ${describeQuery(query)}, expected one: ${listRows(rows)}`);
  const [row] = rows as [InboxRow];
  if (outcomeText(row) !== expectedText(expected)) {
    throw new Mismatch(`${describeQuery(query)}: expected [${expectedText(expected)}], got [${outcomeText(row)}]`);
  }
  return row;
}

async function inboxRows(sql: Sql, query: InboxQuery): Promise<InboxRow[]> {
  const rows = await sql<
    {
      id: string;
      activity_id: string | null;
      activity_type: string | null;
      actor_ap_id: string | null;
      state: string;
      error: string | null;
    }[]
  >`
    select id, activity_id, activity_type, actor_ap_id, state, error from inbox_raw
    where received_at >= ${query.since}
      ${query.actor ? sql`and actor_ap_id = ${query.actor}` : sql``}
      ${query.type ? sql`and activity_type = ${query.type}` : sql``}
      ${query.contains ? sql`and position(${query.contains} in replace(convert_from(body, 'UTF8'), '\\/', '/')) > 0` : sql``}
    order by received_at`;
  return rows.map((r) => ({
    id: r.id,
    activityId: r.activity_id,
    type: r.activity_type,
    actor: r.actor_ap_id,
    state: r.state,
    error: r.error,
  }));
}

/**
 * Waits for the matching row to leave `pending`, then compares it. A row that never arrives
 * fails after `timeoutMs` with what the query was; a wrong outcome fails at once, since a
 * settled row does not change.
 */
export async function expectInbound(
  sql: Sql,
  query: InboxQuery,
  expected: InboxExpectation,
  { timeoutMs = 30_000 } = {},
): Promise<InboxRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await inboxRows(sql, query);
    const settled = rows.filter((row) => row.state !== 'pending');
    if (settled.length >= 2 || (settled.length === 1 && rows.length === 1)) return matchInbound(rows, query, expected);
    if (Date.now() >= deadline) return matchInbound(rows, query, expected);
    await sleep(500);
  }
}

// ------------------------------------------------------------------ deliveries

export type DeliveryExpectation = {
  state: 'pending' | 'delivered' | 'failed' | 'skipped';
  /** The last HTTP status the peer answered; absent means "do not care". */
  status?: number;
  /** `last_error` equals this; `null` means no error recorded. Absent means "do not care". */
  error?: string | null;
  attempts?: number;
};

export type DeliveryQuery = {
  since: Date;
  type?: string;
  /** The delivery's object (`deliveries.object_ap_id`). */
  object?: string;
  /** The peer's inbox URL. */
  inbox?: string;
  /** The peer's host (`lemmy.lab.test`): any of its inboxes. */
  host?: string;
  /** The delivery's activity id. */
  activity?: string;
  /** The `type` of the activity inside an Announce (`Create`, `Update`, `Delete`, `Like`), or of its object. */
  inner?: string;
  /** Text the delivery's body must contain (a title). */
  contains?: string;
};

export type DeliveryRow = {
  activityApId: string;
  type: string;
  inbox: string;
  state: string;
  attempts: number;
  status: number | null;
  error: string | null;
  nextAttemptAt: Date;
};

const deliveryOutcome = (row: Pick<DeliveryRow, 'state' | 'status' | 'error' | 'attempts'>) =>
  `${row.state} status=${row.status ?? 'none'} error=${row.error ?? 'none'} attempts=${row.attempts}`;

const describeDelivery = (query: DeliveryQuery) =>
  [
    query.type,
    query.inner && `of ${query.inner}`,
    query.object && `about ${query.object}`,
    query.contains && `containing ${query.contains}`,
    query.inbox && `to ${query.inbox}`,
    query.host && `to ${query.host}`,
  ]
    .filter(Boolean)
    .join(' ') || 'any delivery';

export function matchDelivery(rows: readonly DeliveryRow[], query: DeliveryQuery, expected: DeliveryExpectation): DeliveryRow {
  if (rows.length === 0) throw new Mismatch(`no delivery for ${describeDelivery(query)}; expected state ${expected.state}`);
  if (rows.length > 1) {
    throw new Mismatch(
      `${rows.length} deliveries for ${describeDelivery(query)}, expected one: ${rows.map((r) => `${r.type} to ${r.inbox} [${deliveryOutcome(r)}]`).join('; ')}`,
    );
  }
  const [row] = rows as [DeliveryRow];
  const wrong =
    row.state !== expected.state ||
    (expected.status !== undefined && row.status !== expected.status) ||
    (expected.error !== undefined && row.error !== expected.error) ||
    (expected.attempts !== undefined && row.attempts !== expected.attempts);
  if (wrong) {
    const want = `${expected.state}${expected.status === undefined ? '' : ` status=${expected.status}`}${expected.error === undefined ? '' : ` error=${expected.error ?? 'none'}`}${expected.attempts === undefined ? '' : ` attempts=${expected.attempts}`}`;
    throw new Mismatch(`${describeDelivery(query)}: expected [${want}], got [${deliveryOutcome(row)}]`);
  }
  return row;
}

export async function deliveryRows(sql: Sql, query: DeliveryQuery): Promise<DeliveryRow[]> {
  const rows = await sql<
    {
      activity_ap_id: string;
      activity_type: string;
      inbox_url: string;
      state: string;
      attempts: number;
      last_status: number | null;
      last_error: string | null;
      next_attempt_at: Date;
    }[]
  >`
    select activity_ap_id, activity_type, inbox_url, state, attempts, last_status, last_error, next_attempt_at from deliveries
    where created_at >= ${query.since}
      ${query.type ? sql`and activity_type = ${query.type}` : sql``}
      ${query.object ? sql`and object_ap_id = ${query.object}` : sql``}
      ${query.inbox ? sql`and inbox_url = ${query.inbox}` : sql``}
      ${query.host ? sql`and inbox_url like ${`https://${query.host}/%`}` : sql``}
      ${query.activity ? sql`and activity_ap_id = ${query.activity}` : sql``}
      ${query.inner ? sql`and body::jsonb -> 'object' ->> 'type' = ${query.inner}` : sql``}
      ${query.contains ? sql`and position(${query.contains} in body) > 0` : sql``}
    order by created_at`;
  return rows.map((r) => ({
    activityApId: r.activity_ap_id,
    type: r.activity_type,
    inbox: r.inbox_url,
    state: r.state,
    attempts: r.attempts,
    status: r.last_status,
    error: r.last_error,
    nextAttemptAt: r.next_attempt_at,
  }));
}

/** Waits until the one matching delivery is in the expected state (a delivery changes state as retries run). */
export async function expectDelivery(
  sql: Sql,
  query: DeliveryQuery,
  expected: DeliveryExpectation,
  { timeoutMs = 30_000 } = {},
): Promise<DeliveryRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await deliveryRows(sql, query);
    try {
      return matchDelivery(rows, query, expected);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await sleep(500);
  }
}
