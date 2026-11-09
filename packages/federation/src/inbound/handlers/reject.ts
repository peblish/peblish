import { db } from '@peblish/core/db/read';
import { follows } from '@peblish/core/db/tables/follows';
import { removeFollow } from '@peblish/core/follows/follow';
import { eq } from 'drizzle-orm';
import { grantFor } from '../authorize.ts';
import { prepared, type InboundHandler } from '../handler.ts';
import { skip } from '../reasons.ts';

// A remote community refuses or ends a follow of ours. core deletes only the follow the
// Reject names, and only when the Reject comes from the followed community (spike finding 3).
export const handler: InboundHandler = {
  type: 'Reject',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Reject') throw new TypeError('the Reject handler was given another activity');
    const followApId = activity.object.follow.apId;
    const [row] = await db()
      .select({ followerId: follows.followerId, followeeId: follows.followeeId })
      .from(follows)
      .where(eq(follows.apId, followApId));
    if (!row) throw skip('target.missing', followApId);
    return prepared(ctx, async (t) => {
      const subject = { followerId: row.followerId, followeeId: row.followeeId, apId: followApId };
      await removeFollow.within(t, await grantFor(ctx, t, 'follow.remove', subject));
      return { objectApId: followApId };
    });
  },
};
