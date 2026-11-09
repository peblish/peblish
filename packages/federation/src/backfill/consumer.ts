import { actors } from '@peblish/core/db/tables/actors';
import { defineConsumer } from '@peblish/core/outbox/consumers';
import { queueBackfill } from '@peblish/core/remote/backfill';
import { eq } from 'drizzle-orm';

// Our follow of a remote community was accepted: queue the backfill of what it already has
// (run.ts, run by job.ts). The row is the queue; this only writes it, in the consumer's own
// transaction, so the queueing commits with the cursor. A follow of a community on this
// server, or a remote actor following one of ours, needs no backfill.
export const consumer = defineConsumer({
  name: 'federation.backfill',
  events: ['follow.accepted'],
  startAt: 'beginning',
  async handle(event, t) {
    if (!event.followerLocal || event.followeeLocal) return;
    const [community] = await t.db
      .select({ kind: actors.kind, local: actors.local, deletedAt: actors.deletedAt })
      .from(actors)
      .where(eq(actors.id, event.followeeId));
    if (community?.kind !== 'Group' || community.local || community.deletedAt) return;
    await queueBackfill(t, event.followeeId);
  },
});
