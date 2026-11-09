import { acceptFollow } from '@peblish/core/follows/follow';
import { grantFor } from '../authorize.ts';
import { prepared, type InboundHandler } from '../handler.ts';
import { skip } from '../reasons.ts';

// A remote community accepts a Follow of ours. core matches the Follow's id, the local follower
// the Accept names (the actor of the Follow it embeds) and the accepting community (the
// activity's actor), all three (spike finding 3): an Accept from anyone else changes nothing. An
// Accept that names its Follow by IRI only never gets here (classify.ts skips it).
export const handler: InboundHandler = {
  type: 'Accept',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Accept') throw new TypeError('the Accept handler was given another activity');
    const { apId: followApId, followerApId } = activity.object.follow;
    // A variable, not a literal: follow.accept takes `followerApId` once FED-A's fix lands, and
    // this compiles on both sides of that merge.
    const subject = { followApId, followerApId };
    return prepared(ctx, async (t) => {
      const { accepted } = await acceptFollow.within(t, await grantFor(ctx, t, 'follow.accept', subject));
      if (!accepted) throw skip('duplicate', followApId);
      return { objectApId: followApId };
    });
  },
};
