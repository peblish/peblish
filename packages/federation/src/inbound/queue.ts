import { inboxRaw } from '@peblish/core/db/tables/federation';
import { tx, type OpenTx } from '@peblish/core/tx/tx';
import { and, eq, like, or, sql } from 'drizzle-orm';

// The inbox_raw queue: leasing pending rows for the job, settling them, and putting the rows
// that waited for an object back in line. Every worker may run the job; a row is claimed with
// FOR UPDATE SKIP LOCKED under a lease, so two workers never process one row, and a worker
// that dies leaves a lease that runs out (at-least-once; the dedupe marker makes a second
// apply a no-op).
//
// Every claim has a generation: `attempts`, which each lease raises by one. A worker whose
// lease ran out and whose row was leased again holds a stale generation, so what it settles,
// retries or renews matches no row and throws ClaimLost; inside the applying transaction that
// rolls the apply back, and the worker that holds the row does it instead. Workers renew the
// lease as they go, so a slow row is not taken from a worker that is still working on it.

export type InboxRow = {
  id: string;
  activityId: string | null;
  activityType: string | null;
  actorApId: string | null;
  body: Uint8Array;
  headers: unknown;
  attempts: number;
  receivedAt: Date;
};

/** The row a worker holds and the generation of its claim. */
export type Claim = Pick<InboxRow, 'id' | 'attempts'>;

/** The row was leased again after this worker's lease ran out: whatever it was doing is not its to settle. */
export class ClaimLost extends Error {
  override readonly name = 'ClaimLost';
  constructor(claim: Claim) {
    super(`the lease on inbox row ${claim.id} (attempt ${claim.attempts}) is no longer held`);
  }
}

/** Most times a row is tried when its failures are transient (a peer down, a database error). */
export const maxAttempts = 8;
export const leaseSeconds = 300;

/** Claims up to `limit` pending rows, oldest first. */
export async function leasePending(limit: number): Promise<InboxRow[]> {
  const rows = await tx((t) =>
    t.db.execute<{
      id: string;
      activityId: string | null;
      activityType: string | null;
      actorApId: string | null;
      body: Uint8Array;
      headers: unknown;
      attempts: number;
      receivedAt: Date;
    }>(sql`
      update ${inboxRaw} set
        attempts = attempts + 1,
        lease_until = now() + ${leaseSeconds} * interval '1 second'
      where id in (
        select id from ${inboxRaw}
        where state = 'pending' and (lease_until is null or lease_until < now())
        order by received_at, id
        limit ${limit}
        for update skip locked
      )
      returning
        id,
        activity_id as "activityId",
        activity_type as "activityType",
        actor_ap_id as "actorApId",
        body,
        headers,
        attempts,
        received_at as "receivedAt"`),
  );
  return [...rows];
}

export type Settled = { state: 'applied' | 'skipped' | 'failed'; error: string | null };

/** The row only while this claim is the one held: still pending, at the generation it was leased with. */
const held = (claim: Claim) => and(eq(inboxRaw.id, claim.id), eq(inboxRaw.attempts, claim.attempts), eq(inboxRaw.state, 'pending'));

/** What a row settled for good keeps of its body: enough to see what it was. */
export const keptPrefixBytes = 1024;

/** The longest error text a settled row keeps (a `target.missing` one excepted): it can quote the peer's document. */
export const maxErrorLength = 512;

/**
 * Whether a settled row's body will be read again: an applied one is the relay's exact bytes,
 * and one skipped for want of an object goes back in line when it arrives (requeueWaiting).
 * Every other end (failed, or skipped for good) keeps only the first `keptPrefixBytes`, so a
 * peer's rejected bodies do not stay on disk for the retention period (throttle.ts intakeByteBudget).
 */
const bodyKept = ({ state, error }: Settled): boolean =>
  state === 'applied' || (state === 'skipped' && error !== null && error.startsWith('target.missing '));

/**
 * `error` cut to `maxErrorLength` characters, an ellipsis last. A `target.missing` error is kept
 * whole: requeueWaiting matches the ids it names, and its row keeps its body anyway (bodyKept).
 */
export function boundedError(error: string): string {
  if (error.length <= maxErrorLength || error.startsWith('target.missing ')) return error;
  const cut = error.slice(0, maxErrorLength - 1);
  // Never half of a surrogate pair.
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

/** Records how a row ended, its body and error bounded as above. Throws ClaimLost when the claim is no longer held. */
export async function settle(t: OpenTx, claim: Claim, settled: Settled): Promise<void> {
  const { state } = settled;
  const error = settled.error === null ? null : boundedError(settled.error);
  const body = bodyKept(settled) ? {} : { body: sql`substring(${inboxRaw.body} from 1 for ${keptPrefixBytes})` };
  const rows = await t.db
    .update(inboxRaw)
    .set({ state, error, processedAt: new Date(), leaseUntil: null, ...body })
    .where(held(claim))
    .returning({ id: inboxRaw.id });
  if (rows.length === 0) throw new ClaimLost(claim);
}

export const settleAlone = (claim: Claim, settled: Settled): Promise<void> => tx((t) => settle(t, claim, settled));

/**
 * Asserts, inside the caller's transaction, that this claim is still the one held, and keeps it
 * so until the transaction ends: the row is locked (a lease or a settlement by another worker
 * waits) and its lease renewed. A member of a batch is applied in a transaction of its own that
 * does not settle the row; this is what makes a worker that lost the row roll it back. Throws
 * ClaimLost when the claim is not held.
 */
export async function holdClaim(t: OpenTx, claim: Claim): Promise<void> {
  const rows = await t.db
    .update(inboxRaw)
    .set({ leaseUntil: sql`now() + ${leaseSeconds} * interval '1 second'` })
    .where(held(claim))
    .returning({ id: inboxRaw.id });
  if (rows.length === 0) throw new ClaimLost(claim);
}

/** Extends the lease by a full lease period. Throws ClaimLost when the claim is no longer held. */
export async function renewLease(claim: Claim): Promise<void> {
  const rows = await tx((t) =>
    t.db
      .update(inboxRaw)
      .set({ leaseUntil: sql`now() + ${leaseSeconds} * interval '1 second'` })
      .where(held(claim))
      .returning({ id: inboxRaw.id }),
  );
  if (rows.length === 0) throw new ClaimLost(claim);
}

/**
 * A transient failure: the row waits (30 seconds, doubling, at most an hour) and is tried again,
 * until `maxAttempts`, when it fails for good with the last error. A claim that is no longer
 * held changes nothing: the worker that holds the row decides.
 */
export async function retryLater(row: Claim, error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (row.attempts >= maxAttempts) {
    return settleAlone(row, { state: 'failed', error: `gave up after ${row.attempts} attempts: ${message}` }).catch(ignoreClaimLost);
  }
  const delaySeconds = Math.min(30 * 2 ** (row.attempts - 1), 3600);
  await tx((t) =>
    t.db
      .update(inboxRaw)
      .set({ error: boundedError(message), leaseUntil: sql`now() + ${delaySeconds} * interval '1 second'` })
      .where(held(row)),
  );
}

/**
 * The row steps aside without having failed (a fetch was refused, so what is left of it waits for
 * the next turn): it is pending again after `delaySeconds`, and the attempt this claim used is
 * given back, so a delivery that keeps waiting for fetches cannot run out of attempts by waiting.
 * Throws ClaimLost when the claim is no longer held. The generation (`attempts`) a worker whose
 * lease ran out holds can then match again only until the next lease raises it; whatever such a
 * worker settles is the complete result of its own pass, so nothing it does conflicts.
 */
export async function yieldLater(claim: Claim, delaySeconds: number, note: string): Promise<void> {
  const rows = await tx((t) =>
    t.db
      .update(inboxRaw)
      .set({
        attempts: sql`${inboxRaw.attempts} - 1`,
        error: note,
        leaseUntil: sql`now() + ${delaySeconds} * interval '1 second'`,
      })
      .where(held(claim))
      .returning({ id: inboxRaw.id }),
  );
  if (rows.length === 0) throw new ClaimLost(claim);
}

function ignoreClaimLost(error: unknown): void {
  if (!(error instanceof ClaimLost)) throw error;
}

/** Whether the error text of a skipped row (reasons.ts missingTargets) names `apId`, matched whole between spaces. */
const names = (apId: string) => sql`position(${` ${apId} `}::text in ' ' || ${inboxRaw.error} || ' ') > 0`;

/**
 * Sets the rows skipped for want of any of `apIds` (target.missing <ap_id> ...) back to pending, in the
 * caller's transaction: an object that has just been stored may be what a vote, an edit or a
 * moderator's action was waiting for. Returns how many rows went back in line.
 */
export async function requeueWaiting(t: OpenTx, apIds: readonly string[]): Promise<number> {
  if (apIds.length === 0) return 0;
  const rows = await t.db
    .update(inboxRaw)
    .set({ state: 'pending', error: null, leaseUntil: null, processedAt: null })
    .where(and(eq(inboxRaw.state, 'skipped'), like(inboxRaw.error, 'target.missing %'), or(...apIds.map(names))))
    .returning({ id: inboxRaw.id });
  return rows.length;
}

/**
 * For lane REM's backfill: after it stores the object at `apId` (say the lemmy.world post an
 * earlier Dislike was about), call this and the activities that were skipped for want of it
 * are applied by the next run of the inbound job. Returns how many were put back.
 */
export const requeueSkippedFor = (apId: string): Promise<number> => tx((t) => requeueWaiting(t, [apId]));
