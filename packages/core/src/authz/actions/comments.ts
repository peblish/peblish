import type { Uuid } from '@peblish/schema/ids';
import type { RefusalReason } from '@peblish/schema/refusal';
import { eq, sql } from 'drizzle-orm';
import { maxCommentDepth } from '../../comments/input.ts';
import { actors } from '../../db/tables/actors.ts';
import { authUser } from '../../db/tables/auth.ts';
import { comments } from '../../db/tables/content.ts';
import { allow, deny, forNoKeyUpdate, forShare, type PolicyRequest, type PolicyResult } from '../policy.ts';
import { ownerAuthority } from '../roles.ts';
import { commentState, commentingDenial, communityDenial, isBanned, liveDenial, postState, type CommentState } from '../state.ts';

// Owned by lane D. Rows are read in the lock order of state.ts: the acting actor, the
// community, the post, the comment. Lane AZ's guards do the locked reads of the thread's
// state (commentingDenial for a new comment, commentState for the author's actions) and each
// takes the rows a write body updates FOR NO KEY UPDATE: the post and the parent comment,
// whose counters createComment updates, and the comment itself.

/**
 * Whether the account behind a local Person has not verified its email yet (lane A's request).
 * The same read as post.create's (authz/actions/posts.ts): through actors.user_id, FOR SHARE
 * under lock, before the community is read. A Person without an account row cannot sign in,
 * so there is nothing to refuse.
 */
async function emailUnverified(request: Pick<PolicyRequest<unknown>, 'db' | 'lock'>, actorId: Uuid): Promise<boolean> {
  const [actor] = await forShare(request.db.select({ userId: actors.userId }).from(actors).where(eq(actors.id, actorId)), request.lock);
  if (!actor?.userId) return false;
  const [user] = await forShare(
    request.db.select({ emailVerified: authUser.emailVerified }).from(authUser).where(eq(authUser.id, actor.userId)),
    request.lock,
  );
  return user?.emailVerified === false;
}

/** Whether the actor is a community (a Group): its kind never changes, so the read needs no lock. */
async function isCommunity(request: Pick<PolicyRequest<unknown>, 'db'>, actorId: Uuid): Promise<boolean> {
  const [actor] = await request.db.select({ kind: actors.kind }).from(actors).where(eq(actors.id, actorId));
  return actor?.kind === 'Group';
}

/**
 * comment.create, for a reply to a post (parentId null) or to a comment. In this order: a
 * local person needs a verified email; then AZ's commentingDenial (the community is open and
 * has not banned the actor, the post and the comment replied to are live and belong together,
 * and the post is not locked: a lock stops moderators and site admins too, so post.locked is
 * final); then, for a remote author, an Announce must name the remote community the post is in
 * (mod.announce_mismatch); then the depth, where a reply to a comment on level 50 is refused.
 * A remote author is allowed as the owner of what they write: the inbound pipeline has matched
 * the signer to the object's attributedTo. A community does not comment (as it does not post
 * or vote), so a remote Group principal is refused first, before any lock.
 */
const create = async (request: PolicyRequest<{ postId: Uuid; parentId: Uuid | null }>): Promise<PolicyResult> => {
  const { principal, subject, db, lock } = request;
  if (principal.kind === 'system') return deny('auth.required');
  if (principal.kind === 'remote' && (await isCommunity(request, principal.actorId))) return deny('auth.required');
  if (principal.kind === 'local' && (await emailUnverified(request, principal.actorId))) return deny('auth.email_unverified');
  const denied = await commentingDenial(request, principal.actorId, subject);
  if (denied) return denied;
  const post = await postState(request, subject.postId);
  if (!post) return deny('target.not_found');
  if (principal.kind === 'remote' && principal.announcedBy) {
    if (post.community.local || principal.announcedBy.communityId !== post.community.id) return deny('mod.announce_mismatch');
  }
  if (subject.parentId) {
    // The guard has locked this row; a path never changes, so the read is only for its depth.
    const [parent] = await forNoKeyUpdate(
      db
        .select({ depth: sql<number>`nlevel(${comments.path})` })
        .from(comments)
        .where(eq(comments.id, subject.parentId)),
      lock,
    );
    if (!parent) return deny('target.not_found');
    if (parent.depth >= maxCommentDepth) return deny('comment.depth_exceeded');
  }
  const { actorId } = principal;
  return allow(
    principal.kind === 'remote'
      ? { kind: 'owner', actorId }
      : { kind: 'local-role', actorId, role: 'user', communityId: post.community.id },
  );
};

/**
 * The author's own actions on a comment, local or remote. Order, as in lane AZ's and B1's
 * policies: the comment exists, its community is neither deleted nor removed, the principal is
 * the author (comment.author_required), then `check` on the comment's state. A comment a
 * moderator removed takes no author action (target.removed), as a post does. Only the author
 * acts: a moderator removes or restores through mod.remove and mod.restore.
 */
const authorAction =
  (check: (request: PolicyRequest<unknown>, comment: CommentState) => Promise<RefusalReason | null>) =>
  async (request: PolicyRequest<{ commentId: Uuid }>): Promise<PolicyResult> => {
    const { principal } = request;
    if (principal.kind === 'system') return deny('auth.required');
    const comment = await commentState(request, request.subject.commentId);
    if (!comment) return deny('target.not_found');
    const closed = communityDenial(comment.community);
    if (closed) return closed;
    const authority = ownerAuthority(principal, comment.authorId);
    if (!authority) return deny('comment.author_required');
    const refusal = await check(request, comment);
    return refusal ? deny(refusal) : allow(authority);
  };

const reason = (denial: { reason: RefusalReason } | null): RefusalReason | null => denial?.reason ?? null;

export const policies = {
  'comment.create': create,
  // Editing needs the author in good standing and a live post (a deleted or removed post takes
  // no edits, as Lemmy); a lock does not stop it, since a lock stops new comments.
  'comment.update': authorAction(async (request, comment) => {
    if (await isBanned(request, comment.community.id, comment.authorId)) return 'community.banned';
    return reason(liveDenial(comment)) ?? reason(liveDenial(comment.post));
  }),
  // Retracting your own comment needs none of that.
  'comment.delete': authorAction(async (_request, comment) => reason(liveDenial(comment))),
};
