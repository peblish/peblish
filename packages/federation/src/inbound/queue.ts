import { inboxRaw } from '@peblish/core/db/tables/federation';
import { tx, type OpenTx } from '@peblish/core/tx/tx';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { missingTarget } from './reasons.ts';

// The inbox_raw queue: leasing pending rows for the job, settling them, and putting the rows
// that waited for an object back in line. Every worker may run the job; a row is claimed with
// FOR UPDATE SKIP LOCKED under a lease, so two workers never process one row, and a worker
// that dies leaves a lease that runs out (at-least-once; the dedupe marker makes a second
// apply a no-op).

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

/** Records how a row ended. */
export async function settle(t: OpenTx, rowId: string, { state, error }: Settled): Promise<void> {
  await t.db.update(inboxRaw).set({ state, error, processedAt: new Date(), leaseUntil: null }).where(eq(inboxRaw.id, rowId));
}

export const settleAlone = (rowId: string, settled: Settled): Promise<void> => tx((t) => settle(t, rowId, settled));

/**
 * A transient failure: the row waits (30 seconds, doubling, at most an hour) and is tried again,
 * until `maxAttempts`, when it fails for good with the last error.
 */
export async function retryLater(row: Pick<InboxRow, 'id' | 'attempts'>, error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (row.attempts >= maxAttempts)
    return settleAlone(row.id, { state: 'failed', error: `gave up after ${row.attempts} attempts: ${message}` });
  const delaySeconds = Math.min(30 * 2 ** (row.attempts - 1), 3600);
  await tx((t) =>
    t.db
      .update(inboxRaw)
      .set({ error: message, leaseUntil: sql`now() + ${delaySeconds} * interval '1 second'` })
      .where(eq(inboxRaw.id, row.id)),
  );
}

/**
 * Sets the rows skipped for want of `apIds` (target.missing <ap_id>) back to pending, in the
 * caller's transaction: an object that has just been stored may be what a vote, an edit or a
 * moderator's action was waiting for. Returns how many rows went back in line.
 */
export async function requeueWaiting(t: OpenTx, apIds: readonly string[]): Promise<number> {
  if (apIds.length === 0) return 0;
  const rows = await t.db
    .update(inboxRaw)
    .set({ state: 'pending', error: null, leaseUntil: null, processedAt: null })
    .where(and(eq(inboxRaw.state, 'skipped'), inArray(inboxRaw.error, apIds.map(missingTarget))))
    .returning({ id: inboxRaw.id });
  return rows.length;
}

/**
 * For lane REM's backfill: after it stores the object at `apId` (say the lemmy.world post an
 * earlier Dislike was about), call this and the activities that were skipped for want of it
 * are applied by the next run of the inbound job. Returns how many were put back.
 */
export const requeueSkippedFor = (apId: string): Promise<number> => tx((t) => requeueWaiting(t, [apId]));
