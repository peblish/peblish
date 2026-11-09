import { db } from '@peblish/core/db/read';
import { removeContent, restoreContent } from '@peblish/core/moderation/remove';
import { deleteComment } from '@peblish/core/comments/delete';
import { deletePost, restorePost } from '@peblish/core/posts/delete';
import { deleteRemoteActor, undeleteRemoteActor } from '@peblish/core/remote/actors';
import type { Activity } from '../../mapping/records.ts';
import { importGrant } from '../../actors/grants.ts';
import { checkCommunity, communityById, grantFor, storedActor, storedContent, type Stored } from '../authorize.ts';
import { prepared, type InboundContext, type InboundHandler, type Prepared } from '../handler.ts';
import { recordDeletion, recordRestoration } from '../ledger.ts';
import { skip, type Skipped } from '../reasons.ts';
import type { Tx } from '@peblish/core/tx/tx';

// Delete. Lemmy and PieFed use one verb for three things:
// - the author deleting their post or comment (no reason): a soft delete the author can undo;
// - a moderator's removal (anyone else, usually with a `summary` reason): mod.remove, restored
//   by Undo(Delete) through mod.restore;
// - an actor deleting itself (the object is the actor): a remote account or community leaving.
// Who may do which is core's policies (post.delete, mod.remove); the pipeline only chooses.

const reasonOf = (reason: string | null) => (reason?.trim() ? reason.slice(0, 10_000) : null);

/** Why `apId` is not content here: a whole community and another account are not the sender's to delete; anything else has not arrived. */
async function notContent(apId: string): Promise<Skipped> {
  const actor = await storedActor(db(), apId);
  if (actor?.kind === 'Group') return skip('community.delete_unsupported', apId);
  return actor ? skip('delete.target_unsupported', apId) : skip('target.missing', apId);
}

/** The stored post or comment `apId` names, or why it is not one (`notContent`). */
async function contentOrWhy(apId: string): Promise<Stored> {
  const target = await storedContent(db(), apId);
  if (!target) throw await notContent(apId);
  return target;
}

/**
 * An author taking back the Delete of their comment. integration: lane d's restoreComment
 * (action comment.restore, event comment.restored; author only, rechecked) replaces the throw:
 *
 *   await restoreComment.within(t, await grantFor(ctx, t, 'comment.restore', { commentId: target.id }));
 */
async function restoreOwnComment(_ctx: InboundContext, _t: Tx, _target: Stored): Promise<void> {
  throw skip('undo.unsupported', 'a comment’s own Delete');
}

/** An author's own Delete: no reason given, and the actor wrote the target. */
const isAuthorsOwn = (sender: { id: string }, target: Stored, reason: string | null) => target.authorId === sender.id && reason === null;

async function prepareActorDelete(ctx: InboundContext): Promise<Prepared> {
  const grant = await importGrant('remote.actor_delete', { apId: ctx.sender.apId });
  // Lemmy's account deletion with "delete content" sets removeData on the Delete; the mapping does not carry it.
  const removeContent = ctx.raw.removeData === true;
  return prepared(ctx, async (t) => {
    const outcome = await deleteRemoteActor.within(t, grant, { removeContent, cause: 'Delete' });
    // integration: deleteRemoteActor answers { actorChanged, contentRemoved } (lane rem); destructure that and drop this line.
    const { actorChanged, contentRemoved } = { actorChanged: outcome.deleted, contentRemoved: outcome.posts + outcome.comments };
    // An actor that was gone already may still have had its content removed by this Delete.
    if (!actorChanged && contentRemoved === 0) throw skip('target.deleted', ctx.sender.apId);
    return { objectApId: ctx.sender.apId };
  });
}

/** Undo(Delete) of the account's own Delete: the actor is alive again (content its deletion removed stays removed). */
async function prepareActorUndelete(ctx: InboundContext): Promise<Prepared> {
  const grant = await importGrant('remote.actor_undelete', { apId: ctx.sender.apId });
  return prepared(ctx, async (t) => {
    await undeleteRemoteActor.within(t, grant);
    return { objectApId: ctx.sender.apId };
  });
}

export const handler: InboundHandler = {
  type: 'Delete',
  async prepare(ctx) {
    const { activity } = ctx;
    if (activity.type !== 'Delete') throw new TypeError('the Delete handler was given another activity');
    if (activity.objectApId === activity.actorApId) return prepareActorDelete(ctx);
    const target = await contentOrWhy(activity.objectApId);
    const community = await communityById(db(), target.communityId);
    checkCommunity(ctx, community, activity.communityApId);
    const reason = reasonOf(activity.reason);
    const relayed = { communityId: community.id, objectApId: target.apId, relay: true };
    return prepared(ctx, async (t) => {
      if (isAuthorsOwn(ctx.sender, target, reason)) {
        if (target.kind === 'comment') await deleteComment.within(t, await grantFor(ctx, t, 'comment.delete', { commentId: target.id }));
        else await deletePost.within(t, await grantFor(ctx, t, 'post.delete', { postId: target.id }));
        await recordDeletion(t, { kind: target.kind, id: target.id, cause: 'Delete', actorId: ctx.sender.id });
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
    if (undone.objectApId === undone.actorApId) return prepareActorUndelete(ctx);
    const target = await contentOrWhy(undone.objectApId);
    const community = await communityById(db(), target.communityId);
    checkCommunity(ctx, community, ctx.activity.communityApId);
    const removal = !isAuthorsOwn(ctx.sender, target, reasonOf(undone.reason));
    return prepared(ctx, async (t) => {
      if (removal) {
        const grant = await grantFor(ctx, t, 'mod.restore', { target: { kind: target.kind, id: target.id } });
        await restoreContent.within(t, grant, { activityApId: ctx.activity.id });
      } else {
        if (target.kind === 'post') await restorePost.within(t, await grantFor(ctx, t, 'post.restore', { postId: target.id }));
        else await restoreOwnComment(ctx, t, target);
        await recordRestoration(t, { kind: target.kind, id: target.id, actorId: ctx.sender.id });
      }
      return { communityId: community.id, objectApId: target.apId, relay: true };
    });
  },
};
