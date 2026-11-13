import { db, type Queryable } from '@peblish/core/db/read';
import { deleteComment } from '@peblish/core/comments/delete';
import { storeRemoteComment, updateRemoteComment } from '@peblish/core/comments/remote';
import { deletePost } from '@peblish/core/posts/delete';
import { storeRemotePost, updateRemotePost } from '@peblish/core/posts/remote';
import { recordDeletion } from '@peblish/core/remote/ledger';
import { readSetting } from '@peblish/core/settings/read';
import type { ResolvedActor } from '../../actors/resolve.ts';
import type { CommentRecord, ContentObject, PostRecord } from '../../mapping/records.ts';
import {
  checkAuthorIsPerson,
  checkContentCommunity,
  checkObject,
  claimedCommunity,
  communityById,
  grantFor,
  storedContent,
  type Stored,
} from '../authorize.ts';
import type { Tx } from '@peblish/core/tx/tx';
import { prepared, type Applied, type InboundContext, type Prepared } from '../handler.ts';
import { skip, type Skipped } from '../reasons.ts';
import { notPublic } from '../visibility.ts';

// Create and Update of a Page (a post) or a Note (a comment), which differ only in the verb:
// an Update for an object we never saw is stored like a Create, as Lemmy does.
//
// An Update is about the object we hold, so what it claims is checked against the stored row
// before anything is authorized or relayed: a Page names the community the post is in, a Note
// replies to what the stored comment replies to. Authorization and the relay both read the
// stored community, never the claimed one, so an author cannot have a community announce a post
// that lives in another.
//
// An Update to content we hold that we would refuse as a new Create (a post made NSFW while
// remote NSFW is not accepted, made NSFL, or a post or comment no longer addressed to Public)
// removes our copy, exactly as the author's own Delete does (handlers/delete.ts): the same
// mutation and event, so pages, the media proxy and the edge purge all follow, and the same
// deletion ledger row. It is not relayed. Content we do not hold is refused as before.

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The community the object says it belongs to, when it says so in `audience`; the claim a comment is checked against. */
const audienceOf = (ctx: InboundContext): string | null => {
  const object = ctx.raw.object;
  return isObject(object) && typeof object.audience === 'string' ? object.audience : null;
};

/**
 * Whether remote sensitive content is stored, for a new post and an edit alike (an author could
 * otherwise post an ordinary page and edit it into one). NSFL is always refused; NSFW only
 * while the site setting `remote_nsfw.accepted` is off, its default. Read in the transaction
 * that stores the post.
 */
async function sensitiveRefusal(q: Queryable, post: Pick<PostRecord, 'apId' | 'sensitive' | 'nsfl'>): Promise<Skipped | null> {
  return post.nsfl || (post.sensitive && !(await readSetting('remote_nsfw.accepted', q))) ? skip('content.nsfw_rejected', post.apId) : null;
}

/** Why an Update would be refused as a new Create for its addressing (classify.ts let it through because we hold its object). */
const withdrawal = (ctx: InboundContext, verb: 'Create' | 'Update'): Skipped | null => (verb === 'Update' ? notPublic(ctx.raw) : null);

/**
 * Removes the copy we hold of what an Update `refused`, as its author's Delete would; a copy
 * already deleted keeps the refusal as the outcome. An Update older than the revision we hold
 * (`revision` is its `updated`) arrived out of order and changes nothing: the delete mutation
 * judges it by the edit path's own rule (olderThanHeld) on the rows its recheck locked, in the
 * one lock order every write keeps, so a concurrent edit either commits first and is seen, or
 * waits for this transaction. Without `updated`, or with one equal to ours, it removes the copy,
 * as such an edit would apply.
 */
async function withdrawHeld(ctx: InboundContext, t: Tx, held: Stored, refused: Skipped, revision: Date | null): Promise<Applied> {
  if (held.deleted) throw refused;
  const deleted =
    held.kind === 'comment'
      ? await deleteComment.within(t, await grantFor(ctx, t, 'comment.delete', { commentId: held.id }), { revision })
      : await deletePost.within(t, await grantFor(ctx, t, 'post.delete', { postId: held.id }), { revision });
  if (deleted) await recordDeletion(t, { kind: held.kind, id: held.id, cause: 'Delete', actorId: ctx.sender.id });
  return { communityId: held.communityId, objectApId: held.apId };
}

/** The post a Page updates, when we hold it: a post, and the Page must name its community. */
async function heldPostCommunity(q: Queryable, held: Stored, post: PostRecord): Promise<ResolvedActor> {
  if (held.kind !== 'post') throw skip('object.exists', post.apId);
  const community = await communityById(q, held.communityId);
  if (community.apId !== post.communityApId) throw skip('community.mismatch', `${post.communityApId} is not ${community.apId}`);
  return community;
}

async function preparePage(ctx: InboundContext, post: PostRecord, verb: 'Create' | 'Update'): Promise<Prepared> {
  const hidden = withdrawal(ctx, verb);
  const held = verb === 'Update' ? await storedContent(db(), post.apId) : null;
  if (hidden && !held) throw hidden;
  checkAuthorIsPerson(ctx);
  checkObject(ctx.activity.actorApId, post);
  const community = held ? await heldPostCommunity(db(), held, post) : await claimedCommunity(ctx, post.communityApId);
  if (community.kind !== 'Group') throw skip('community.mismatch', post.communityApId);
  await checkContentCommunity(ctx, community, null);
  return prepared(ctx, async (t) => {
    // Read again in the transaction: a copy of the Create may have stored it meanwhile.
    const existing = verb === 'Update' ? await storedContent(t.db, post.apId) : null;
    if (existing) {
      if ((await heldPostCommunity(t.db, existing, post)).id !== community.id) throw skip('community.mismatch', post.communityApId);
      const refused = hidden ?? (await sensitiveRefusal(t.db, post));
      if (refused) return withdrawHeld(ctx, t, existing, refused, post.editedAt);
      const grant = await grantFor(ctx, t, 'post.update', { postId: existing.id });
      await updateRemotePost.within(t, grant, post);
      return { communityId: existing.communityId, objectApId: post.apId, relay: true };
    }
    const grant = await grantFor(ctx, t, 'post.create', { communityId: community.id });
    const refused = hidden ?? (await sensitiveRefusal(t.db, post));
    if (refused) throw refused;
    const stored = await storeRemotePost.within(t, grant, post);
    if (!stored.created) throw skip('object.exists', post.apId);
    return {
      communityId: community.id,
      objectApId: post.apId,
      stored: [post.apId],
      page: verb === 'Create' ? post : undefined,
      relay: true,
    };
  });
}

/** A stored comment replies to the post and parent the Note names: an edit never moves a comment. */
function checkSameReply(held: Stored, parent: Stored | null, inReplyToApId: string): void {
  if (held.kind !== 'comment') throw skip('object.exists', held.apId);
  if (!parent || parent.postId !== held.postId || (parent.kind === 'comment' ? parent.id : null) !== held.parentId) {
    throw skip('parent.mismatch', inReplyToApId);
  }
}

async function prepareNote(ctx: InboundContext, comment: CommentRecord, verb: 'Create' | 'Update'): Promise<Prepared> {
  const hidden = withdrawal(ctx, verb);
  const held = verb === 'Update' ? await storedContent(db(), comment.apId) : null;
  if (hidden && !held) throw hidden;
  checkAuthorIsPerson(ctx);
  checkObject(ctx.activity.actorApId, comment);
  const parent = await storedContent(db(), comment.inReplyToApId);
  if (held) checkSameReply(held, parent, comment.inReplyToApId);
  if (!parent) throw skip('target.missing', comment.inReplyToApId);
  const community = await communityById(db(), parent.communityId);
  await checkContentCommunity(ctx, community, audienceOf(ctx));
  return prepared(ctx, async (t) => {
    const existing = await storedContent(t.db, comment.apId);
    if (existing && verb === 'Update') {
      checkSameReply(existing, await storedContent(t.db, comment.inReplyToApId), comment.inReplyToApId);
      if (hidden) return withdrawHeld(ctx, t, existing, hidden, comment.editedAt);
      const grant = await grantFor(ctx, t, 'comment.update', { commentId: existing.id });
      await updateRemoteComment.within(t, grant, comment);
      return { communityId: existing.communityId, objectApId: comment.apId, relay: true };
    }
    if (existing) throw skip('object.exists', comment.apId);
    if (hidden) throw hidden;
    const grant = await grantFor(ctx, t, 'comment.create', {
      postId: parent.postId,
      parentId: parent.kind === 'comment' ? parent.id : null,
    });
    const stored = await storeRemoteComment.within(t, grant, comment);
    if (!stored.created) throw skip('object.exists', comment.apId);
    return { communityId: community.id, objectApId: comment.apId, stored: [comment.apId], relay: true };
  });
}

/** Create or Update of content: the object is a Page or a Note (the classifier refused the rest). */
export function prepareContent(ctx: InboundContext, object: ContentObject, verb: 'Create' | 'Update'): Promise<Prepared> {
  return object.type === 'Page' ? preparePage(ctx, object.post, verb) : prepareNote(ctx, object.comment, verb);
}
