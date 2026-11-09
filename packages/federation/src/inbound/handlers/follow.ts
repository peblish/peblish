import { receiveFollow, removeFollow } from '@peblish/core/follows/follow';
import type { Activity } from '../../mapping/records.ts';
import { grantFor } from '../authorize.ts';
import { prepared, type InboundHandler } from '../handler.ts';
import { skip } from '../reasons.ts';

// A remote actor follows a local community (accepted at once; the delivery consumer sends the
// Accept), or takes the follow back. Only local communities take followers.
export const handler: InboundHandler = {
  type: 'Follow',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Follow') throw new TypeError('the Follow handler was given another activity');
    const { follow } = activity;
    const community = await ctx.actor(follow.followeeApId);
    if (!community.local || community.kind !== 'Group') throw skip('follow.target_unsupported', follow.followeeApId);
    return prepared(ctx, async (t) => {
      const grant = await grantFor(ctx, t, 'follow.receive', { communityId: community.id, followApId: follow.apId });
      await receiveFollow.within(t, grant);
      return { objectApId: community.apId };
    });
  },

  /** Undo(Follow): by the follower, so its follow of that community goes (whatever Follow id it holds now). */
  async undo(ctx, undone: Activity) {
    if (undone.type !== 'Follow') throw new TypeError('the Follow handler was asked to undo another activity');
    const community = await ctx.actor(undone.follow.followeeApId);
    return prepared(ctx, async (t) => {
      const subject = { followerId: ctx.sender.id, followeeId: community.id, apId: null };
      await removeFollow.within(t, await grantFor(ctx, t, 'follow.remove', subject));
      return { objectApId: community.apId };
    });
  },
};
