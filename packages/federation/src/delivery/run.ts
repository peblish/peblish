import { db } from '@peblish/core/db/read';
import { actorKeys } from '@peblish/core/db/tables/actors';
import { deliveries } from '@peblish/core/delivery/tables';
import { isDormant } from '@peblish/core/remote/instances';
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

async function settle(row: Claimed, outcome: Outcome): Promise<void> {
  const done = outcome.state !== 'pending';
  await tx((t) =>
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
      .where(eq(deliveries.id, row.id)),
  );
}

async function signingKey(senderId: string) {
  const [key] = await db()
    .select({ keyId: actorKeys.keyId, privateKeyPem: actorKeys.privateKeyPem })
    .from(actorKeys)
    .where(and(eq(actorKeys.actorId, senderId), eq(actorKeys.algorithm, 'rsa')));
  return key?.privateKeyPem ? { keyId: key.keyId, privateKeyPem: key.privateKeyPem } : null;
}

async function attempt(row: Claimed, fetch: Fetcher): Promise<Outcome> {
  const key = await signingKey(row.senderId);
  if (!key) return { state: 'failed', status: null, error: 'the sender has no signing key', delayMs: 0 };
  let headers: Headers;
  try {
    headers = await signDelivery(key, row.inboxUrl, row.body);
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
  options: Required<Pick<DeliveryOptions, 'fetch' | 'isDormant' | 'refreshSoftware'>>,
): Promise<Outcome> {
  if (row.instanceId && (await options.isDormant(row.instanceId))) {
    return { state: 'skipped', status: null, error: 'the instance is dormant', delayMs: 0 };
  }
  await options.refreshSoftware(new URL(row.inboxUrl).origin);
  return attempt(row, options.fetch);
}

/** Runs the queue until nothing is due (or `maxRows` rows were taken) and says how the rows ended. */
export async function deliverDue(options: DeliveryOptions = {}): Promise<DeliveryCounts> {
  const fetch = options.fetch ?? safeFetch;
  const deps = {
    fetch,
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
    const rows = await claimDue(Math.min(batchSize, maxRows - taken), options.leaseMs);
    if (rows.length === 0) break;
    taken += rows.length;
    await Promise.all(
      rows.map(async (row) => {
        const outcome = await deliver(row, { ...deps, refreshSoftware }).catch((error: unknown): Outcome => {
          // Something of ours broke; the row stays pending and is tried again later.
          console.error(`delivery of ${row.activityApId} to ${row.inboxUrl} broke`, error);
          return { state: 'pending', status: null, error: error instanceof Error ? error.message : String(error), delayMs: 60_000 };
        });
        await settle(row, outcome);
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
