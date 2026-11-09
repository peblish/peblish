import { db } from '@peblish/core/db/read';
import { actorKeys } from '@peblish/core/db/tables/actors';
import { deliveries } from '@peblish/core/delivery/tables';
import { deliveryBlocked, instanceBlocked } from '@peblish/core/peers/gate';
import { isDormant } from '@peblish/core/remote/instances';
import { readSetting } from '@peblish/core/settings/read';
import { tx } from '@peblish/core/tx/tx';
import { and, eq, sql } from 'drizzle-orm';
import type { Fetcher } from '../actors/document.ts';
import { BlockedDestinationError, safeFetch } from '../actors/safe-fetch.ts';
import { userAgent } from '../federation.ts';
import { refreshInstanceSoftware } from '../nodeinfo/client.ts';
import { signDelivery } from '../signing/sign.ts';
import { leaseMs as defaultLeaseMs, maxResponseBytes, parseRetryAfter, requestTimeoutMs, verdict, type Attempt } from './policy.ts';

// The delivery worker's body: claim due rows, sign each once, POST it, record how it went.
// Every worker may run this at once. A row is claimed with FOR UPDATE SKIP LOCKED under a lease
// longer than the request timeout, so a live worker's slow POST is never sent twice, and a
// worker that dies mid-POST leaves a lease that runs out, after which the row is sent again
// (at least once; receivers dedupe on the activity id).
//
// A worker that pauses past its lease (a stalled process, a long GC) can wake up after another
// worker took the row over. Claiming counts an attempt, so `attempts` is the row's version:
// the worker renews its lease just before it sends (and sends nothing if the row is no longer
// its own), and records its outcome only while the row is still pending at the attempt it
// claimed. A stale worker's result is dropped, never written over a newer attempt's.

type Claimed = {
  id: string;
  activityApId: string;
  senderId: string;
  inboxUrl: string;
  instanceId: string | null;
  body: string;
  attempts: number;
};

export type DeliveryOptions = {
  /** Stops claiming new rows once aborted (the worker is shutting down). */
  signal?: AbortSignal;
  fetch?: Fetcher;
  /** Whether deliveries to an instance are skipped; lane REM's policy. */
  isDormant?: (instanceId: string) => Promise<boolean>;
  /** Brings an inbox's instance software up to date before its first delivery. */
  refreshSoftware?: (origin: string) => Promise<void>;
  leaseMs?: number;
  /** Rows claimed and sent together. */
  batchSize?: number;
  /** Most rows one run takes, so the worker returns to its schedule under load. */
  maxRows?: number;
};

export type DeliveryCounts = { delivered: number; retried: number; failed: number; skipped: number };

/** Claims up to `limit` due rows: pending, due, and not leased by a worker that is still alive. */
export async function claimDue(limit: number, leaseMs = defaultLeaseMs): Promise<Claimed[]> {
  return tx((t) =>
    t.db.execute<Claimed>(sql`
      update ${deliveries} set
        attempts = attempts + 1,
        lease_until = now() + ${leaseMs} * interval '1 millisecond'
      where id in (
        select id from ${deliveries}
        where state = 'pending' and next_attempt_at <= now() and (lease_until is null or lease_until < now())
        order by next_attempt_at, id
        limit ${limit}
        for update skip locked
      )
      returning
        id,
        activity_ap_id as "activityApId",
        sender_id as "senderId",
        inbox_url as "inboxUrl",
        instance_id as "instanceId",
        body,
        attempts`),
  ).then((rows) => [...rows]);
}

type Outcome = { state: 'delivered' | 'failed' | 'skipped' | 'pending'; status: number | null; error: string | null; delayMs: number };

/** The row as this worker claimed it: still pending, and still at the attempt it counted. */
const claimedBy = (row: Claimed) => and(eq(deliveries.id, row.id), eq(deliveries.state, 'pending'), eq(deliveries.attempts, row.attempts));

/**
 * Extends the lease of a claimed row just before its POST, so the whole request fits inside it,
 * and says whether the row is still this worker's. False means another worker took it over.
 */
async function renew(row: Claimed, leaseMs: number): Promise<boolean> {
  const renewed = await tx((t) =>
    t.db
      .update(deliveries)
      .set({ leaseUntil: sql`now() + ${leaseMs} * interval '1 millisecond'` })
      .where(claimedBy(row))
      .returning({ id: deliveries.id }),
  );
  return renewed.length > 0;
}

/** Records the outcome of the attempt `row` claimed; false when the row had moved on and nothing was written. */
async function settle(row: Claimed, outcome: Outcome): Promise<boolean> {
  const done = outcome.state !== 'pending';
  const settled = await tx((t) =>
    t.db
      .update(deliveries)
      .set({
        state: outcome.state,
        lastStatus: outcome.status,
        lastError: outcome.error,
        leaseUntil: null,
        nextAttemptAt: done ? undefined : new Date(Date.now() + outcome.delayMs),
        settledAt: done ? new Date() : null,
      })
      .where(claimedBy(row))
      .returning({ id: deliveries.id }),
  );
  return settled.length > 0;
}

async function signingKey(senderId: string) {
  const [key] = await db()
    .select({ keyId: actorKeys.keyId, privateKeyPem: actorKeys.privateKeyPem })
    .from(actorKeys)
    .where(and(eq(actorKeys.actorId, senderId), eq(actorKeys.algorithm, 'rsa')));
  return key?.privateKeyPem ? { keyId: key.keyId, privateKeyPem: key.privateKeyPem } : null;
}

/**
 * Whether the destination is a blocked peer, read just before the POST so a block made after the
 * row was queued still stops it. A row queued before its instance was known has no `instanceId`:
 * the inbox URL's host names the peer then.
 */
const destinationBlocked = (row: Claimed): Promise<boolean> =>
  row.instanceId ? deliveryBlocked(row.instanceId) : instanceBlocked(db(), row.inboxUrl);

const blockedOutcome: Outcome = { state: 'skipped', status: null, error: 'the instance is blocked', delayMs: 0 };

/** Null when the row is no longer this worker's: it sends nothing and records nothing. */
async function attempt(row: Claimed, fetch: Fetcher, leaseMs: number): Promise<Outcome | null> {
  const key = await signingKey(row.senderId);
  if (!key) return { state: 'failed', status: null, error: 'the sender has no signing key', delayMs: 0 };
  let headers: Headers;
  try {
    headers = signDelivery(key, row.inboxUrl, row.body);
  } catch (error) {
    // A key that will not load stays broken on every retry.
    return {
      state: 'failed',
      status: null,
      error: `could not sign: ${error instanceof Error ? error.message : String(error)}`,
      delayMs: 0,
    };
  }
  headers.delete('host');
  headers.set('user-agent', await userAgent());
  if (!(await renew(row, leaseMs))) return null;
  if (await destinationBlocked(row)) return blockedOutcome;
  let result: Attempt;
  let status: number | null = null;
  let note: string | null = null;
  try {
    const response = await fetch(row.inboxUrl, {
      method: 'POST',
      headers,
      body: row.body,
      schemes: ['https:'],
      // A redirect is an answer we record, never a request we make.
      maxRedirects: 0,
      maxBytes: maxResponseBytes,
      timeoutMs: requestTimeoutMs,
    });
    status = response.status;
    result = { status, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) };
    const location = response.headers.get('location');
    note = location ? `redirect to ${location} not followed` : new TextDecoder().decode(response.body).slice(0, 300);
  } catch (error) {
    note = error instanceof Error ? error.message : String(error);
    result = { error: note, permanent: error instanceof BlockedDestinationError };
  }
  const decided = verdict(row.attempts, result);
  const ok = decided.state === 'delivered';
  return { state: decided.state, status, error: ok ? null : note || null, delayMs: decided.state === 'pending' ? decided.delayMs : 0 };
}

async function deliver(
  row: Claimed,
  options: Required<Pick<DeliveryOptions, 'fetch' | 'isDormant' | 'refreshSoftware' | 'leaseMs'>>,
): Promise<Outcome | null> {
  // Checked here too, so a blocked peer is not asked for its NodeInfo either.
  if (await destinationBlocked(row)) return blockedOutcome;
  if (row.instanceId && (await options.isDormant(row.instanceId))) {
    return { state: 'skipped', status: null, error: 'the instance is dormant', delayMs: 0 };
  }
  await options.refreshSoftware(new URL(row.inboxUrl).origin);
  return attempt(row, options.fetch, options.leaseMs);
}

/**
 * Runs the queue until nothing is due (or `maxRows` rows were taken) and says how the rows ended.
 * With the `delivery.enabled` site setting off it claims nothing: rows stay pending, and a switch
 * turned off mid-run stops the run before its next batch.
 */
export async function deliverDue(options: DeliveryOptions = {}): Promise<DeliveryCounts> {
  const fetch = options.fetch ?? safeFetch;
  const leaseMs = options.leaseMs ?? defaultLeaseMs;
  const deps = {
    fetch,
    leaseMs,
    isDormant: options.isDormant ?? isDormant,
    refreshSoftware: options.refreshSoftware ?? ((origin: string) => refreshInstanceSoftware(origin, { fetch })),
  };
  const batchSize = options.batchSize ?? 16;
  const maxRows = options.maxRows ?? 500;
  const counts: DeliveryCounts = { delivered: 0, retried: 0, failed: 0, skipped: 0 };
  // One NodeInfo check per instance per run, however many of its inboxes are due.
  const checked = new Set<string>();
  const refreshSoftware = async (origin: string) => {
    if (checked.has(origin)) return;
    checked.add(origin);
    await deps.refreshSoftware(origin);
  };
  for (let taken = 0; taken < maxRows && !options.signal?.aborted;) {
    if (!(await readSetting('delivery.enabled'))) break;
    const rows = await claimDue(Math.min(batchSize, maxRows - taken), leaseMs);
    if (rows.length === 0) break;
    taken += rows.length;
    await Promise.all(
      rows.map(async (row) => {
        const outcome = await deliver(row, { ...deps, refreshSoftware }).catch((error: unknown): Outcome => {
          // Something of ours broke. The row follows the schedule of a send that failed, so one
          // whose handling keeps throwing ends failed at the attempt cap with the error kept,
          // not pending for ever.
          console.error(`delivery of ${row.activityApId} to ${row.inboxUrl} broke`, error);
          const message = error instanceof Error ? error.message : String(error);
          const decided = verdict(row.attempts, { error: message, permanent: false });
          return { state: decided.state, status: null, error: message, delayMs: decided.state === 'pending' ? decided.delayMs : 0 };
        });
        if (!outcome) {
          console.warn(`delivery of ${row.activityApId} to ${row.inboxUrl} not sent: another worker took the row over`);
          return;
        }
        if (!(await settle(row, outcome))) {
          console.warn(
            `delivery of ${row.activityApId} to ${row.inboxUrl} (attempt ${row.attempts}) ended ${outcome.state} after its lease ran out; the result is dropped`,
          );
          return;
        }
        if (outcome.state === 'pending') counts.retried++;
        else counts[outcome.state]++;
        if (outcome.state !== 'delivered') {
          console.warn(
            `delivery ${outcome.state}: ${row.activityApId} to ${row.inboxUrl} (attempt ${row.attempts}, status ${outcome.status}) ${outcome.error ?? ''}`,
          );
        }
      }),
    );
  }
  return counts;
}
