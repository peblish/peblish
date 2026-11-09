import { acceptFollow } from '@peblish/core/follows/follow';
import { grantFor } from '../authorize.ts';
import { prepared, type InboundHandler } from '../handler.ts';
import { skip } from '../reasons.ts';

// A remote community accepts a Follow of ours. core matches the Follow's id, the local follower
// and the accepting community (the activity's actor), all three (spike finding 3): an Accept
// from anyone else changes nothing. An Accept that names the Follow by IRI only was given its
// Follow by classify.ts.
export const handler: InboundHandler = {
  type: 'Accept',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Accept') throw new TypeError('the Accept handler was given another activity');
    const followApId = activity.object.follow.apId;
    return prepared(ctx, async (t) => {
      const { accepted } = await acceptFollow.within(t, await grantFor(ctx, t, 'follow.accept', { followApId }));
      if (!accepted) throw skip('duplicate', followApId);
      return { objectApId: followApId };
    });
  },
};
