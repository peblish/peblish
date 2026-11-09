import type { Uuid } from '@peblish/schema/ids';
import type { RefusalReason } from '@peblish/schema/refusal';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { authUser } from '../../db/tables/auth.ts';
import { allow, deny, forNoKeyUpdate, forShare, type PolicyRequest, type PolicyResult } from '../policy.ts';
import { communityRole, ownerAuthority } from '../roles.ts';
import { communityDenial, isBanned, postState, postingDenial, type PostState } from '../state.ts';

// Owned by lane B1. Rows are read in the lock order of state.ts: the acting actor, the
// community, the post. Lane AZ's guards refuse removed communities and community bans
// (postingDenial, and communityDenial and isBanned for the author actions).

/**
 * Whether the account behind a local Person has not verified its email yet (lane A's request).
 * Read through actors.user_id, FOR SHARE under lock, before the community is read: the
 * principal refresh holds the actor row and auth_user row the same way. A Person without an
 * account row cannot sign in, so there is no address to verify and nothing to refuse.
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

/**
 * Whether the acting principal is a remote community (a Group). A community neither authors
 * posts nor casts votes: the people in it do, relayed by its Announce. Its principal also
 * deadlocks the policies below: the refresh holds the community's own row FOR SHARE, the policy
 * then takes the same row FOR NO KEY UPDATE, and two concurrent requests each wait for the
 * other (40P01). So a policy asks first and refuses with post.group_cannot_act before it locks
 * anything; an actor's kind never changes, so this read needs no lock.
 */
export async function isGroupPrincipal({ principal, db }: Pick<PolicyRequest<unknown>, 'principal' | 'db'>): Promise<boolean> {
  if (principal.kind !== 'remote') return false;
  const [actor] = await db.select({ kind: actors.kind }).from(actors).where(eq(actors.id, principal.actorId));
  return actor?.kind === 'Group';
}

/**
 * post.create. A local person needs a verified email, then the community must exist, not be
 * deleted, not be removed and not have banned them (AZ's postingDenial), then a restricted
 * community lets only its moderators, its owner and site admins post. A remote author is
 * allowed as the owner of what they post: the inbound pipeline has matched the signer to the
 * object's attributedTo (Authority.owner); a remote community itself is refused
 * (isGroupPrincipal), and an Announce must name the remote community the post is in
 * (mod.announce_mismatch). A remote community enforces its own restriction, so a remote
 * author in one is not checked against the mirrored flag.
 */
const create = async (request: PolicyRequest<{ communityId: Uuid }>): Promise<PolicyResult> => {
  const { principal, subject, db, lock } = request;
  if (principal.kind === 'system') return deny('auth.required');
  if (await isGroupPrincipal(request)) return deny('post.group_cannot_act');
  if (principal.kind === 'local' && (await emailUnverified(request, principal.actorId))) return deny('auth.email_unverified');
  // FOR NO KEY UPDATE: a community ban recorded as an INSERT (lane AZ) locks this row first
  // (PolicyRequest.lock), so a ban and a post take turns.
  const [community] = await forNoKeyUpdate(
    db
      .select({ kind: actors.kind, local: actors.local, deletedAt: actors.deletedAt, restricted: actors.postingRestrictedToMods })
      .from(actors)
      .where(eq(actors.id, subject.communityId)),
    lock,
  );
  if (community?.kind !== 'Group') return deny('target.not_found');
  if (community.deletedAt) return deny('target.deleted');
  const denied = await postingDenial({ db, lock }, principal.actorId, subject.communityId);
  if (denied) return denied;
  const { actorId } = principal;
  // An Announce can only come from the remote community the post is in (as lane AZ's mod.* policies read it).
  if (principal.kind === 'remote' && principal.announcedBy) {
    if (community.local || principal.announcedBy.communityId !== subject.communityId) return deny('mod.announce_mismatch');
  }
  // Who the grant names: a remote author acts as the owner of the post; a local one by role.
  const granted = (role: 'user' | 'moderator' | 'owner') =>
    allow(
      principal.kind === 'remote' ? { kind: 'owner', actorId } : { kind: 'local-role', actorId, role, communityId: subject.communityId },
    );
  if (!community.restricted || (principal.kind === 'remote' && !community.local)) return granted('user');
  if (principal.kind === 'local' && principal.siteRole === 'admin') return allow({ kind: 'site-admin', actorId });
  const role = await communityRole(request, subject.communityId, actorId);
  return role ? granted(role) : deny('community.posting_restricted');
};

/**
 * The author's own actions on a post, local or remote. Order, as in lane AZ's policies: the
 * post exists, its community is neither deleted nor removed, the principal is the author
 * (post.author_required), then `check` on the post's state. A post a moderator removed takes
 * no author action but a moderator's restore (target.removed), as lock and pin do. Only the
 * author acts: a moderator removes or restores through mod.remove and mod.restore.
 */
const authorAction =
  (check: (request: PolicyRequest<unknown>, post: PostState) => Promise<RefusalReason | null>) =>
  async (request: PolicyRequest<{ postId: Uuid }>): Promise<PolicyResult> => {
    const { principal } = request;
    if (principal.kind === 'system') return deny('auth.required');
    if (await isGroupPrincipal(request)) return deny('post.group_cannot_act');
    const post = await postState(request, request.subject.postId);
    if (!post) return deny('target.not_found');
    const closed = communityDenial(post.community);
    if (closed) return closed;
    const authority = ownerAuthority(principal, post.authorId);
    if (!authority) return deny('post.author_required');
    const refusal = await check(request, post);
    return refusal ? deny(refusal) : allow(authority);
  };

/** Editing and restoring need the author to be in good standing; deleting your own post does not. */
const banned = async (request: PolicyRequest<unknown>, post: PostState): Promise<RefusalReason | null> =>
  (await isBanned(request, post.community.id, post.authorId)) ? 'community.banned' : null;

const gone = (post: PostState): RefusalReason | null => (post.deleted ? 'target.deleted' : post.removed ? 'target.removed' : null);

export const policies = {
  'post.create': create,
  'post.update': authorAction(async (request, post) => (await banned(request, post)) ?? gone(post)),
  'post.delete': authorAction(async (_request, post) => gone(post)),
  'post.restore': authorAction(
    async (request, post) => (await banned(request, post)) ?? (post.removed ? 'target.removed' : post.deleted ? null : 'post.not_deleted'),
  ),
};
