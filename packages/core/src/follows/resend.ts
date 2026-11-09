import { and, eq, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { Refused } from '../tx/refused.ts';
import { retryFollow } from './follow.ts';
import { followRetryOffsetsMs, retryDue } from './retry.ts';

/**
 * Sends every unanswered Follow of a local actor to a remote community again when its retry is
 * due at `now` (retry.ts). Returns how many it sent. A follow another worker answered or resent
 * first is skipped.
 *
 * Follows are picked by an unfinished stage, never by age: one whose last send came before the
 * final offset still has a resend owed, however long ago it was made, so a worker that was down
 * through the whole window sends it when it returns (one resend covers every stage then due).
 * A follow past its last stage is left out here and stays pending for good.
 */
export async function retryUnansweredFollows(now = new Date()): Promise<number> {
  const follower = alias(actors, 'follower');
  const followee = alias(actors, 'followee');
  const pending = await db()
    .select({ id: follows.id, createdAt: follows.createdAt, sentAt: follows.sentAt })
    .from(follows)
    .innerJoin(follower, eq(follower.id, follows.followerId))
    .innerJoin(followee, eq(followee.id, follows.followeeId))
    .where(
      and(
        eq(follows.state, 'pending'),
        eq(follower.local, true),
        eq(followee.local, false),
        // The first stage has come due...
        lte(follows.createdAt, new Date(now.getTime() - followRetryOffsetsMs[0])),
        // ...and the last send came before the final one, so some stage is still owed.
        sql`coalesce(${follows.sentAt}, ${follows.createdAt}) < ${follows.createdAt} + ${followRetryOffsetsMs[followRetryOffsetsMs.length - 1]} * interval '1 millisecond'`,
      ),
    );
  const principal = await systemPrincipal(db(), 'scheduled');
  let sent = 0;
  for (const row of pending.filter((candidate) => retryDue(candidate, now))) {
    const decision = await authorize('follow.retry', principal, { followId: row.id });
    if (!decision.ok) continue;
    try {
      if ((await retryFollow(decision.grant, { now })).retried) sent++;
    } catch (error) {
      // The follow was answered or removed between the read and the write.
      if (!(error instanceof Refused)) throw error;
    }
  }
  return sent;
}
