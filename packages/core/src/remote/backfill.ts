import type { Uuid } from '@peblish/schema/ids';
import { and, eq, sql } from 'drizzle-orm';
import { actors } from '../db/tables/actors.ts';
import { defineMutation } from '../tx/mutation.ts';
import type { OpenTx } from '../tx/tx.ts';
import { backfills } from './tables.ts';

// Owned by lane REM. The queue of FEP-7888 style backfills of followed remote communities. The
// consumer in federation/src/backfill queues a community when our follow of it is accepted; the
// job there claims it, fetches, and settles it. This is the queue's side: three small writes.

/** The backfill's figures, as data. */
export type BackfillLimits = {
  posts: number;
  commentsPerPost: number;
  comments: number;
  collectionPages: number;
  collectionItems: number;
  requests: number;
  leaseMs: number;
  /** A run makes no request in the last part of its lease, so it settles while it still owns the row. */
  settleMarginMs: number;
  retryAfterMs: readonly number[];
};

export const backfillLimits: BackfillLimits = {
  /** Posts stored per community, the featured collection first. */
  posts: 50,
  /** Comments stored for one post, and for the whole community, from a `context` or `replies` collection a post offers. */
  commentsPerPost: 100,
  comments: 500,
  /** Pages followed in one collection. */
  collectionPages: 3,
  /** Items read from one collection. */
  collectionItems: 100,
  /** Requests to peers one backfill may make; the run stops there, keeping what it stored. */
  requests: 250,
  /** A worker owns a claimed backfill this long; a worker that dies leaves a lease that runs out. */
  leaseMs: 15 * 60 * 1000,
  settleMarginMs: 60 * 1000,
  /** A run that failed for a reason that may pass (the peer is down) is tried again after these waits, then it fails for good. */
  retryAfterMs: [5 * 60 * 1000, 60 * 60 * 1000],
};

export const maxBackfillAttempts = backfillLimits.retryAfterMs.length + 1;

/**
 * Queues the backfill of a community, in the caller's open transaction (an outbox consumer's).
 * A community that is pending or running is left alone; one that finished, or failed, is queued
 * again, as following it again should refill what was missed.
 */
export async function queueBackfill(t: Pick<OpenTx, 'db'>, communityId: Uuid): Promise<void> {
  await t.db
    .insert(backfills)
    .values({ communityId })
    .onConflictDoUpdate({
      target: backfills.communityId,
      set: {
        state: 'pending',
        attempts: 0,
        nextAttemptAt: sql`now()`,
        leaseUntil: null,
        queuedAt: sql`now()`,
        finishedAt: null,
        note: null,
      },
      setWhere: sql`${backfills.state} in ('done', 'failed')`,
    });
}

/**
 * Which claim of a backfill a worker holds. A claim is the pair of its attempt number and the
 * lease it was given; a worker whose lease ran out and whose backfill another worker took over
 * no longer matches the row, and its result is dropped.
 */
export type BackfillClaim = { attempt: number; leaseUntil: Date };

export type ClaimedBackfill = BackfillClaim & {
  communityId: Uuid;
  apId: string;
  outboxUrl: string | null;
  featuredUrl: string | null;
};

/** Takes the next due backfill (pending, or running under a lease that ran out) and leases it; null when none is due. */
export const claimBackfill = defineMutation({
  action: 'remote.backfill_claim',
  emits: ['backfill.started'],
  async run(t, _grant, input: { now: Date }): Promise<ClaimedBackfill | null> {
    const now = input.now.toISOString();
    const leaseUntil = new Date(input.now.getTime() + backfillLimits.leaseMs).toISOString();
    const claimed = await t.db.execute<{ communityId: Uuid; attempts: number }>(sql`
      update ${backfills} set state = 'running', attempts = attempts + 1, lease_until = ${leaseUntil}::timestamptz
      where community_id = (
        select community_id from ${backfills}
        where (state = 'pending' and next_attempt_at <= ${now}::timestamptz)
           or (state = 'running' and lease_until < ${now}::timestamptz)
        order by next_attempt_at, community_id
        limit 1
        for update skip locked)
      returning community_id as "communityId", attempts`);
    const [row] = claimed;
    if (!row) return null;
    const [community] = await t.db
      .select({ apId: actors.apId, outboxUrl: actors.outboxUrl, featuredUrl: actors.featuredUrl })
      .from(actors)
      .where(eq(actors.id, row.communityId));
    if (!community) return null;
    await t.emit({ type: 'backfill.started', v: 1, communityId: row.communityId, attempt: row.attempts });
    return { communityId: row.communityId, attempt: row.attempts, leaseUntil: new Date(leaseUntil), ...community };
  },
});

export type BackfillResult = { claim: BackfillClaim } & (
  | { outcome: 'done' | 'failed'; posts: number; comments: number; note: string | null; now: Date }
  | { outcome: 'retry'; posts: number; comments: number; note: string | null; retryAt: Date }
);

/**
 * Records how a claimed backfill's run ended: done, failed for good, or to be tried again at
 * `retryAt`. Settles only the claim the result names (`settled: false` otherwise: the lease
 * ran out and another worker has the backfill, or it was settled already).
 */
export const settleBackfill = defineMutation({
  action: 'remote.backfill_settle',
  emits: ['backfill.settled'],
  async run(t, grant, input: BackfillResult) {
    const { communityId } = grant.subject;
    const counts = {
      posts: sql`${backfills.posts} + ${input.posts}`,
      comments: sql`${backfills.comments} + ${input.comments}`,
      note: input.note,
    };
    const [row] = await t.db
      .update(backfills)
      .set(
        input.outcome === 'retry'
          ? { ...counts, state: 'pending', nextAttemptAt: input.retryAt, leaseUntil: null }
          : { ...counts, state: input.outcome, leaseUntil: null, finishedAt: input.now },
      )
      .where(
        and(
          eq(backfills.communityId, communityId),
          eq(backfills.state, 'running'),
          eq(backfills.attempts, input.claim.attempt),
          eq(backfills.leaseUntil, input.claim.leaseUntil),
        ),
      )
      .returning({ posts: backfills.posts, comments: backfills.comments });
    if (!row) return { settled: false };
    if (input.outcome !== 'retry') {
      await t.emit({ type: 'backfill.settled', v: 1, communityId, state: input.outcome, posts: row.posts, comments: row.comments });
    }
    return { settled: true };
  },
});
