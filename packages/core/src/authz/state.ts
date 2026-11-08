import type { ContentRef, Uuid } from '@peblish/schema/ids';
import type { RefusalReason } from '@peblish/schema/refusal';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { communityBans, communityRemovals } from '../moderation/tables.ts';
import { forNoKeyUpdate, forShare, type PolicyRequest, type PolicyResult } from './policy.ts';

// Owned by lane AZ. Target state for policies, read with the caller's db and lock (a recheck
// reads everything locked). Lock order, which every policy and write body keeps so two
// rechecking writers never wait on each other in a cycle: the acting actor (the principal
// refresh in authorize()), then the community's actor row, then the post, then the comment.
// So these readers find the community through an unlocked read of the post's community_id
// first, and a policy calls them before its own locked reads of those rows.
//
// Rows a write body updates are read FOR NO KEY UPDATE: the community row (post counters,
// and the parent row of the INSERT-recorded revocations here: a ban, a removal), posts and
// comments (counts, tallies, moderation flags) and ban rows (a new ban replaces an expired
// one). Removal markers are inserted or deleted, never updated, so FOR SHARE.

/** The part of a policy request the state readers use. */
export type StateRead = Pick<PolicyRequest<unknown>, 'db' | 'lock'>;

export type Denial = Extract<PolicyResult, { ok: false }>;

const refuse = (reason: RefusalReason): Denial => ({ ok: false, reason });

export type CommunityState = { id: Uuid; apId: string; local: boolean; deleted: boolean; removed: boolean };

export type PostState = {
  kind: 'post';
  id: Uuid;
  apId: string;
  authorId: Uuid;
  community: CommunityState;
  deleted: boolean;
  removed: boolean;
  locked: boolean;
  pinned: boolean;
};

export type CommentState = {
  kind: 'comment';
  id: Uuid;
  apId: string;
  authorId: Uuid;
  post: PostState;
  community: CommunityState;
  deleted: boolean;
  removed: boolean;
};

export type ContentState = PostState | CommentState;

/** A community (a Group actor) and whether it is removed; null when no such Group exists. */
export async function communityState(read: StateRead, communityId: Uuid): Promise<CommunityState | null> {
  const [community] = await forNoKeyUpdate(
    read.db
      .select({ id: actors.id, apId: actors.apId, kind: actors.kind, local: actors.local, deletedAt: actors.deletedAt })
      .from(actors)
      .where(eq(actors.id, communityId)),
    read.lock,
  );
  if (community?.kind !== 'Group') return null;
  const [removal] = await forShare(
    read.db
      .select({ removedAt: communityRemovals.removedAt })
      .from(communityRemovals)
      .where(eq(communityRemovals.communityId, communityId)),
    read.lock,
  );
  return { id: community.id, apId: community.apId, local: community.local, deleted: community.deletedAt !== null, removed: !!removal };
}

export async function postState(read: StateRead, postId: Uuid): Promise<PostState | null> {
  const [ref] = await read.db.select({ communityId: posts.communityId }).from(posts).where(eq(posts.id, postId));
  if (!ref) return null;
  const community = await communityState(read, ref.communityId);
  if (!community) return null;
  const [post] = await forNoKeyUpdate(
    read.db
      .select({
        id: posts.id,
        apId: posts.apId,
        authorId: posts.authorId,
        communityId: posts.communityId,
        deletedAt: posts.deletedAt,
        removedAt: posts.removedAt,
        locked: posts.locked,
        pinned: posts.featuredCommunity,
      })
      .from(posts)
      .where(eq(posts.id, postId)),
    read.lock,
  );
  // A post that moved between the two reads is treated as gone rather than read unlocked.
  if (post?.communityId !== community.id) return null;
  return {
    kind: 'post',
    id: post.id,
    apId: post.apId,
    authorId: post.authorId,
    community,
    deleted: post.deletedAt !== null,
    removed: post.removedAt !== null,
    locked: post.locked,
    pinned: post.pinned,
  };
}

export async function commentState(read: StateRead, commentId: Uuid): Promise<CommentState | null> {
  const [ref] = await read.db.select({ postId: comments.postId }).from(comments).where(eq(comments.id, commentId));
  if (!ref) return null;
  const post = await postState(read, ref.postId);
  if (!post) return null;
  const [comment] = await forNoKeyUpdate(
    read.db
      .select({
        id: comments.id,
        apId: comments.apId,
        authorId: comments.authorId,
        postId: comments.postId,
        deletedAt: comments.deletedAt,
        removedAt: comments.removedAt,
      })
      .from(comments)
      .where(eq(comments.id, commentId)),
    read.lock,
  );
  if (comment?.postId !== post.id) return null;
  return {
    kind: 'comment',
    id: comment.id,
    apId: comment.apId,
    authorId: comment.authorId,
    post,
    community: post.community,
    deleted: comment.deletedAt !== null,
    removed: comment.removedAt !== null,
  };
}

export const contentState = (read: StateRead, target: ContentRef): Promise<ContentState | null> =>
  target.kind === 'post' ? postState(read, target.id) : commentState(read, target.id);

/** Whether a ban of actorId from communityId is in force: no expiry, or one still ahead. */
export async function isBanned(read: StateRead, communityId: Uuid, actorId: Uuid): Promise<boolean> {
  const [ban] = await forNoKeyUpdate(
    read.db
      .select({ actorId: communityBans.actorId })
      .from(communityBans)
      .where(
        and(
          eq(communityBans.communityId, communityId),
          eq(communityBans.actorId, actorId),
          or(isNull(communityBans.expiresAt), gt(communityBans.expiresAt, sql`now()`)),
        ),
      ),
    read.lock,
  );
  return !!ban;
}

/** Why nothing may happen in a community any more (deleted, or removed by an admin), if so. */
export function communityDenial(community: CommunityState): Denial | null {
  if (community.deleted) return refuse('community.deleted');
  if (community.removed) return refuse('community.removed');
  return null;
}

/**
 * post.create's guard (authz/actions/posts.ts), after the policy's own community checks: the
 * community is not removed and the author is not banned from it.
 */
export async function postingDenial(read: StateRead, actorId: Uuid, communityId: Uuid): Promise<Denial | null> {
  const community = await communityState(read, communityId);
  if (!community) return refuse('target.not_found');
  if (community.deleted) return refuse('target.deleted');
  if (community.removed) return refuse('community.removed');
  if (await isBanned(read, communityId, actorId)) return refuse('community.banned');
  return null;
}

/**
 * The guard for taking part in a thread: vote.cast (authz/actions/votes.ts) and comment.create
 * (lane D, through commentingDenial). The target and its community exist and are neither
 * deleted nor removed, and the actor is not banned from the community. Call it before the
 * policy's own locked reads (lock order above).
 */
export async function participationDenial(read: StateRead, actorId: Uuid, target: ContentRef): Promise<Denial | null> {
  const state = await contentState(read, target);
  return state ? participation(read, actorId, state) : refuse('target.not_found');
}

async function participation(read: StateRead, actorId: Uuid, state: ContentState): Promise<Denial | null> {
  const closed = communityDenial(state.community);
  if (closed) return closed;
  if (await isBanned(read, state.community.id, actorId)) return refuse('community.banned');
  return liveDenial(state);
}

/** Why a post or comment can take no part any more (deleted, or removed by a moderator), if so. */
export function liveDenial(state: ContentState): Denial | null {
  if (state.deleted) return refuse('target.deleted');
  if (state.removed) return refuse('target.removed');
  return null;
}

/**
 * comment.create's guard (lane D): participation on the post, the comment replied to (if any)
 * belongs to it and is neither deleted nor removed, and the post is not locked (post.locked).
 * If moderators may comment on locked posts, the policy checks roles.ts before treating
 * post.locked as final.
 */
export async function commentingDenial(
  read: StateRead,
  actorId: Uuid,
  subject: { postId: Uuid; parentId: Uuid | null },
): Promise<Denial | null> {
  const parent = subject.parentId ? await commentState(read, subject.parentId) : await postState(read, subject.postId);
  const post = parent?.kind === 'comment' ? parent.post : parent;
  if (!parent || post?.id !== subject.postId) return refuse('target.not_found');
  return (
    (await participation(read, actorId, post)) ??
    (parent.kind === 'comment' ? liveDenial(parent) : null) ??
    (post.locked ? refuse('post.locked') : null)
  );
}
