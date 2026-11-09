import { db } from '@peblish/core/db/read';
import { removeContent, restoreContent } from '@peblish/core/moderation/remove';
import { deleteComment } from '@peblish/core/comments/delete';
import { deletePost, restorePost } from '@peblish/core/posts/delete';
import { deleteRemoteActor } from '@peblish/core/remote/actors';
import type { Activity } from '../../mapping/records.ts';
import { importGrant } from '../../actors/grants.ts';
import { checkCommunity, communityById, grantFor, requireContent, type Stored } from '../authorize.ts';
import { prepared, type InboundContext, type InboundHandler, type Prepared } from '../handler.ts';
import { skip } from '../reasons.ts';

// Delete. Lemmy and PieFed use one verb for three things:
// - the author deleting their post or comment (no reason): a soft delete the author can undo;
// - a moderator's removal (anyone else, usually with a `summary` reason): mod.remove, restored
//   by Undo(Delete) through mod.restore;
// - an actor deleting itself (the object is the actor): a remote account or community leaving.
// Who may do which is core's policies (post.delete, mod.remove); the pipeline only chooses.

const reasonOf = (reason: string | null) => (reason?.trim() ? reason.slice(0, 10_000) : null);

/** An author's own Delete: no reason given, and the actor wrote the target. */
const isAuthorsOwn = (sender: { id: string }, target: Stored, reason: string | null) => target.authorId === sender.id && reason === null;

async function prepareActorDelete(ctx: InboundContext): Promise<Prepared> {
  const grant = await importGrant('remote.actor_delete', { apId: ctx.sender.apId });
  return prepared(ctx, async (t) => {
    const { deleted } = await deleteRemoteActor.within(t, grant);
    if (!deleted) throw skip('target.deleted', ctx.sender.apId);
    return { objectApId: ctx.sender.apId };
  });
}

export const handler: InboundHandler = {
  type: 'Delete',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Delete') throw new TypeError('the Delete handler was given another activity');
    if (activity.objectApId === activity.actorApId) return prepareActorDelete(ctx);
    const target = await requireContent(db(), activity.objectApId);
    const community = await communityById(db(), target.communityId);
    checkCommunity(ctx, community, activity.communityApId);
    const reason = reasonOf(activity.reason);
    const relayed = { communityId: community.id, objectApId: target.apId, relay: true };
    return prepared(ctx, async (t) => {
      if (isAuthorsOwn(ctx.sender, target, reason)) {
        if (target.kind === 'comment') await deleteComment.within(t, await grantFor(ctx, t, 'comment.delete', { commentId: target.id }));
        else await deletePost.within(t, await grantFor(ctx, t, 'post.delete', { postId: target.id }));
      } else {
        const grant = await grantFor(ctx, t, 'mod.remove', { target: { kind: target.kind, id: target.id } });
        await removeContent.within(t, grant, { reason, activityApId: activity.id });
      }
      return relayed;
    });
  },

  /** Undo(Delete): the author takes the delete back, or a moderator restores what was removed. */
  async undo(ctx, undone: Activity) {
    if (undone.type !== 'Delete') throw new TypeError('the Delete handler was asked to undo another activity');
    if (undone.objectApId === undone.actorApId) throw skip('undo.unsupported', 'an actor’s own Delete');
    const target = await requireContent(db(), undone.objectApId);
    const community = await communityById(db(), target.communityId);
    checkCommunity(ctx, community, ctx.activity.communityApId);
    const removal = !isAuthorsOwn(ctx.sender, target, reasonOf(undone.reason));
    return prepared(ctx, async (t) => {
      if (removal) {
        const grant = await grantFor(ctx, t, 'mod.restore', { target: { kind: target.kind, id: target.id } });
        await restoreContent.within(t, grant, { activityApId: ctx.activity.id });
      } else if (target.kind === 'post') {
        await restorePost.within(t, await grantFor(ctx, t, 'post.restore', { postId: target.id }));
      } else {
        throw skip('undo.unsupported', 'a comment’s own Delete');
      }
      return { communityId: community.id, objectApId: target.apId, relay: true };
    });
  },
};
