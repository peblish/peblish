import type { Authority } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { and, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { authUser } from '../db/tables/auth.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { moderatorCache, type CommunityRole } from './moderators-cache.ts';
import { allow, deny, forShare, type PolicyRequest, type PolicyResult } from './policy.ts';
import { isBanned, type CommunityState, type StateRead } from './state.ts';

// Owned by lane AZ. Role resolution for a principal against a subject, read with the
// request's db and lock (lock order in state.ts). Site bans are lane MODF's: they are checked
// in the principal refresh (principal.ts), so a site-banned actor never reaches a policy that
// runs with lock.

/**
 * A local row grants until its expires_at, if it has one. A remote row mirrors the community's
 * moderators collection: it grants only once verified and until its expires_at, so a mirror
 * that was never confirmed, or not refreshed in time, grants nothing. Exported so the read
 * models that list moderators or badges apply the same rule.
 */
export const freshModerator = or(
  and(eq(communityModerators.source, 'local'), or(isNull(communityModerators.expiresAt), gt(communityModerators.expiresAt, sql`now()`))),
  and(eq(communityModerators.source, 'remote'), isNotNull(communityModerators.verifiedAt), gt(communityModerators.expiresAt, sql`now()`)),
);

/**
 * The actor's role among the community's moderators, or null. Without lock a positive answer
 * may come from the moderator cache; with lock (a recheck) the row is read FOR SHARE, so a
 * demotion waits for the write or is seen.
 */
export async function communityRole(read: StateRead, communityId: Uuid, actorId: Uuid): Promise<CommunityRole | null> {
  const cache = moderatorCache();
  const cached = read.lock ? undefined : cache.get(communityId, actorId);
  if (cached) return cached;
  const [row] = await forShare(
    read.db
      .select({ role: communityModerators.role, expiresAt: communityModerators.expiresAt })
      .from(communityModerators)
      .where(and(eq(communityModerators.communityId, communityId), eq(communityModerators.moderatorId, actorId), freshModerator)),
    read.lock,
  );
  if (!row) return null;
  cache.set(communityId, actorId, row.role, row.expiresAt);
  return row.role;
}

/** Whether a local Person's account is a site admin (the actor's auth_user row). */
export async function isSiteAdmin(read: StateRead, userId: Uuid | null): Promise<boolean> {
  if (!userId) return false;
  const [user] = await forShare(read.db.select({ role: authUser.role }).from(authUser).where(eq(authUser.id, userId)), read.lock);
  return user?.role === 'admin';
}

/** The owner authority when the principal is the object's author; null otherwise. */
export function ownerAuthority(principal: PolicyRequest<unknown>['principal'], authorId: Uuid): Authority | null {
  return principal.actorId === authorId ? { kind: 'owner', actorId: principal.actorId } : null;
}

/**
 * Who may moderate in `community`, checked in this order:
 * 1. a local site admin (site-admin authority);
 * 2. a remote principal whose activity arrived inside an Announce: allowed when the announcing
 *    community is the remote community that owns the subject (community-announce authority,
 *    decision 10), refused with mod.announce_mismatch for any other community;
 * 3. anyone banned from the community is refused (community.banned);
 * 4. a fresh moderator or owner row (local-role authority with that role).
 * Everyone else, the instance's own system principal included, gets mod.moderator_required.
 */
export async function moderationAuthority(
  request: Pick<PolicyRequest<unknown>, 'principal' | 'db' | 'lock'>,
  community: CommunityState,
): Promise<PolicyResult> {
  const { principal } = request;
  if (principal.kind === 'local' && principal.siteRole === 'admin') return allow({ kind: 'site-admin', actorId: principal.actorId });
  if (principal.kind === 'remote' && principal.announcedBy) {
    const { communityId, announceApId } = principal.announcedBy;
    return !community.local && communityId === community.id
      ? allow({ kind: 'community-announce', communityId, announceApId })
      : deny('mod.announce_mismatch');
  }
  if (principal.kind === 'system') return deny('mod.moderator_required');
  if (await isBanned(request, community.id, principal.actorId)) return deny('community.banned');
  const role = await communityRole(request, community.id, principal.actorId);
  return role ? allow({ kind: 'local-role', actorId: principal.actorId, role, communityId: community.id }) : deny('mod.moderator_required');
}
