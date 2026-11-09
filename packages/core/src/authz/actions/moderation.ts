import type { ContentRef, Uuid } from '@peblish/schema/ids';
import type { RefusalReason } from '@peblish/schema/refusal';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { deny, forShare, type PolicyRequest, type PolicyResult } from '../policy.ts';
import { communityRole, isSiteAdmin, moderationAuthority } from '../roles.ts';
import {
  communityDenial,
  communityState,
  contentState,
  isBanned,
  liveDenial,
  postState,
  type CommunityState,
  type ContentState,
  type PostState,
} from '../state.ts';

// Owned by lane AZ: community-scope moderation. Site ban and unban are lane MODF's
// (actions/bans.ts). Every policy checks, in order: the target exists (target.not_found); its
// community is neither deleted nor removed; the principal may moderate there (roles.ts:
// moderationAuthority); then the target's own state for this action. Rows are read in the
// lock order of state.ts.

/** Shared by the post and comment actions: the checks above, then `check` on the target's state. */
async function moderateContent<S extends ContentState>(
  request: PolicyRequest<unknown>,
  target: S | null,
  check: (target: S) => RefusalReason | null,
): Promise<PolicyResult> {
  if (!target) return deny('target.not_found');
  const closed = communityDenial(target.community);
  if (closed) return closed;
  const authority = await moderationAuthority(request, target.community);
  if (!authority.ok) return authority;
  const refusal = check(target);
  return refusal ? deny(refusal) : authority;
}

const live = (target: ContentState): RefusalReason | null => liveDenial(target)?.reason ?? null;

const content =
  (check: (target: ContentState) => RefusalReason | null) =>
  async (request: PolicyRequest<{ target: ContentRef }>): Promise<PolicyResult> =>
    moderateContent(request, await contentState(request, request.subject.target), check);

/**
 * The post actions (lock, unlock, pin, unpin) refuse a removed or deleted post first
 * (target.removed, target.deleted), unlock and unpin included: such a post takes no moderation
 * but its restore. So inbound federation's mirror of an Undo(Lock), or of a Remove from the
 * featured collection (unpin), on such a post must treat those two refusals as a no-op, or
 * restore the post first.
 */
const post =
  (check: (target: PostState) => RefusalReason | null) =>
  async (request: PolicyRequest<{ postId: Uuid }>): Promise<PolicyResult> =>
    moderateContent(request, await postState(request, request.subject.postId), (target) => live(target) ?? check(target));

/**
 * A community ban or unban: the community, the authority, then the target actor. A ban never
 * targets yourself, the instance actor, a site admin or one of the community's moderators
 * (target.protected; demote them first), nor a deleted actor. The target's rows are read FOR
 * SHARE, never stronger: the target's own rechecked writes hold its actor row FOR SHARE before
 * they lock the community, so a stronger lock here, taken after the community's, would wait on
 * them in a cycle.
 */
const member =
  (ban: boolean) =>
  async (request: PolicyRequest<{ communityId: Uuid; targetActorId: Uuid }>): Promise<PolicyResult> => {
    const { subject, principal } = request;
    const community = await communityState(request, subject.communityId);
    if (!community) return deny('target.not_found');
    const closed = communityDenial(community);
    if (closed) return closed;
    const authority = await moderationAuthority(request, community);
    if (!authority.ok) return authority;
    const [target] = await forShare(
      request.db
        .select({ id: actors.id, kind: actors.kind, local: actors.local, userId: actors.userId, deletedAt: actors.deletedAt })
        .from(actors)
        .where(eq(actors.id, subject.targetActorId)),
      request.lock,
    );
    if (!target || target.kind === 'Group') return deny('target.not_found');
    const banned = await isBanned(request, community.id, target.id);
    if (!ban) return banned ? authority : deny('target.not_banned');
    if (target.id === principal.actorId || target.kind === 'Application' || (await isProtectedMember(request, community, target)))
      return deny('target.protected');
    if (target.deletedAt) return deny('target.deleted');
    return banned ? deny('target.banned') : authority;
  };

async function isProtectedMember(request: PolicyRequest<unknown>, community: CommunityState, target: { id: Uuid; userId: Uuid | null }) {
  return (await isSiteAdmin(request, target.userId)) || (await communityRole(request, community.id, target.id)) !== null;
}

export const policies = {
  'mod.remove': content((target) => live(target)),
  'mod.restore': content((target) => (target.deleted ? 'target.deleted' : target.removed ? null : 'target.not_removed')),
  'mod.lock': post((target) => (target.locked ? 'target.locked' : null)),
  'mod.unlock': post((target) => (target.locked ? null : 'target.not_locked')),
  'mod.pin': post((target) => (target.pinned ? 'target.pinned' : null)),
  'mod.unpin': post((target) => (target.pinned ? null : 'target.not_pinned')),
  'mod.ban': member(true),
  'mod.unban': member(false),
};
