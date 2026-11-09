import { db } from '@peblish/core/db/read';
import { lockPost, unlockPost } from '@peblish/core/moderation/lock';
import { checkCommunity, communityById, grantFor, requireContent } from '../authorize.ts';
import { prepared, type InboundContext, type Prepared } from '../handler.ts';
import { skip } from '../reasons.ts';

/**
 * Lock and Undo(Lock) of a post. Lemmy 0.19 federates a lock as this activity (a Page's
 * commentsEnabled is only read as a hint and never changes the stored flag: posts/remote.ts).
 * A removed or deleted post takes neither (core refuses target.removed and target.deleted), which
 * the row records as the skip.
 */
export async function prepareLock(ctx: InboundContext, objectApId: string, locking: boolean): Promise<Prepared> {
  const target = await requireContent(db(), objectApId);
  if (target.kind !== 'post') throw skip('target.missing', objectApId);
  const community = await communityById(db(), target.communityId);
  checkCommunity(ctx, community, ctx.activity.communityApId);
  return prepared(ctx, async (t) => {
    const input = { activityApId: ctx.activity.id };
    if (locking) await lockPost.within(t, await grantFor(ctx, t, 'mod.lock', { postId: target.id }), input);
    else await unlockPost.within(t, await grantFor(ctx, t, 'mod.unlock', { postId: target.id }), input);
    return { communityId: community.id, objectApId, relay: true };
  });
}
