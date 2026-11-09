import { ACTOR_NAME } from '@peblish/schema/actor-urls';
import type { ActingPrincipal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { MINIMUM_AGE, RESERVED_NAMES } from '@peblish/schema/identity';
import { and, eq, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/read.ts';
import { actors } from '../../db/tables/actors.ts';
import { authUser } from '../../db/tables/auth.ts';
import { communityModerators } from '../../db/tables/moderation.ts';
import type { Frozen } from '../frozen.ts';
import { allow, deny, forNoKeyUpdate, forShare, type PolicyRequest, type PolicyResult } from '../policy.ts';
import { moderationAuthority } from '../roles.ts';
import { communityDenial, communityState, isBanned } from '../state.ts';

// Owned by lane F: local communities (M14). Admins create them; the owner, a moderator or an
// admin edit them; the owner or an admin manage the moderators. Rows are read in the lock
// order of state.ts: the community's actor row first (communityState, FOR NO KEY UPDATE: every
// write here updates it or inserts rows that hang off it), then what the decision rests on.
// Moderator rows are only ever read FOR SHARE or, for the one row set_moderator changes,
// FOR NO KEY UPDATE after the community row, so writers of one community take turns on that row
// and never wait on each other in a cycle.

/**
 * A site admin with two-factor on, as lane A's admin policies (identity.ts) decide it. The
 * recheck's principal refresh already drops an admin without two-factor to 'user'; this
 * precheck says why when a session claims admin that the database does not back.
 */
async function denyUnlessAdmin(principal: Frozen<ActingPrincipal>, db: Queryable, lock: boolean): Promise<PolicyResult | null> {
  if (principal.kind !== 'local' || principal.siteRole !== 'admin') return deny('auth.admin_required');
  const [admin] = await forShare(
    db
      .select({ role: authUser.role, twoFactorEnabled: authUser.twoFactorEnabled })
      .from(actors)
      .innerJoin(authUser, eq(authUser.id, actors.userId))
      .where(eq(actors.id, principal.actorId)),
    lock,
  );
  if (admin?.role !== 'admin') return deny('auth.admin_required');
  if (!admin.twoFactorEnabled) return deny('admin.two_factor_required');
  return null;
}

type Role = 'owner' | 'moderator';

export const policies = {
  /**
   * A signed-in local person declares they are 16 or older on the NSFW gate page. The caller
   * computes `age` from the date of birth it never stores, as account.register does: null when
   * the date is not a real one. The body writes only the person's own declaration row.
   */
  'age.declare': async ({ principal, subject }: PolicyRequest<{ age: number | null }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    if (subject.age === null) return deny('age.declaration_required');
    if (subject.age < MINIMUM_AGE) return deny('age.under_16');
    return allow({ kind: 'owner', actorId: principal.actorId });
  },

  /**
   * A site admin with two-factor creates a community under a name that is valid, not reserved
   * and free among all local actors, Persons included, in any case. The insert's unique index
   * settles a race between two creates (the mutation refuses name.taken).
   */
  'community.create': async ({ principal, subject, db, lock }: PolicyRequest<{ name: string }>) => {
    const denied = await denyUnlessAdmin(principal, db, lock);
    if (denied) return denied;
    if (!ACTOR_NAME.test(subject.name)) return deny('name.invalid');
    if (RESERVED_NAMES.has(subject.name.toLowerCase())) return deny('name.reserved');
    const [taken] = await db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.local, true), sql`lower(${actors.name}) = ${subject.name.toLowerCase()}`));
    if (taken) return deny('name.taken');
    return allow({ kind: 'site-admin', actorId: principal.actorId });
  },

  /** The owner, a moderator or a site admin edits a local community that is neither deleted nor removed. */
  'community.update': async (request: PolicyRequest<{ communityId: Uuid }>) => {
    if (request.principal.kind !== 'local') return deny('auth.required');
    const community = await communityState(request, request.subject.communityId);
    if (!community) return deny('target.not_found');
    if (!community.local) return deny('community.not_local');
    const closed = communityDenial(community);
    if (closed) return closed;
    return moderationAuthority(request, community);
  },

  /**
   * The owner or a site admin appoints a moderator or an owner, changes a role, or removes the
   * actor from the moderators (role null) in a local community. The target is a live Person
   * other than yourself (target.protected: an owner is never left without one, since the last
   * owner cannot remove themselves), not banned from the community when appointed, and the
   * role must differ from the one held (community.role_unchanged).
   */
  'community.set_moderator': async (request: PolicyRequest<{ communityId: Uuid; actorId: Uuid; role: Role | null }>) => {
    const { principal, subject, db, lock } = request;
    if (principal.kind !== 'local') return deny('auth.required');
    const community = await communityState(request, subject.communityId);
    if (!community) return deny('target.not_found');
    if (!community.local) return deny('community.not_local');
    const closed = communityDenial(community);
    if (closed) return closed;
    const authority = await moderationAuthority(request, community);
    if (!authority.ok) return authority.reason === 'mod.moderator_required' ? deny('community.owner_required') : authority;
    if (authority.authority.kind === 'local-role' && authority.authority.role !== 'owner') return deny('community.owner_required');

    // The target's actor row is only read here (FOR SHARE), as a community ban reads its target's.
    const [target] = await forShare(
      db.select({ kind: actors.kind, deletedAt: actors.deletedAt }).from(actors).where(eq(actors.id, subject.actorId)),
      lock,
    );
    if (target?.kind !== 'Person' && target?.kind !== 'Application') return deny('target.not_found');
    if (target.kind === 'Application' || subject.actorId === principal.actorId) return deny('target.protected');
    if (target.deletedAt) return deny('target.deleted');
    if (subject.role !== null && (await isBanned(request, community.id, subject.actorId))) return deny('target.banned');

    // The write body changes this row, so it is read FOR NO KEY UPDATE; an expired row holds no role.
    const [held] = await forNoKeyUpdate(
      db
        .select({ role: communityModerators.role, expiresAt: communityModerators.expiresAt })
        .from(communityModerators)
        .where(and(eq(communityModerators.communityId, community.id), eq(communityModerators.moderatorId, subject.actorId))),
      lock,
    );
    const current = held && (!held.expiresAt || held.expiresAt.getTime() > Date.now()) ? held.role : null;
    if (current === subject.role) return deny('community.role_unchanged');
    return authority;
  },
};
