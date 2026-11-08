import type { ActingPrincipal } from '@peblish/schema/authz';
import type { RefusalReason } from '@peblish/schema/refusal';
import { eq } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';

/**
 * Re-reads the principal inside the writing transaction (authorize() with lock), so a
 * session or grant issued earlier cannot outlive a deletion or a demotion: the actor must
 * still exist, match the principal's kind and not be deleted, and a local principal's site
 * role comes from auth_user, not the session: 'admin' only when role is admin and two-factor
 * is on (A03, as SessionView.siteRole). Rows are read FOR SHARE so a concurrent
 * demotion or deletion waits for the write, and a site ban (which takes FOR NO KEY UPDATE on
 * the actor row before inserting) does too. A write body therefore must not update the acting
 * actor's own row, except self-deletion: deleteAccount (identity/delete.ts) locks the owner's
 * row FOR NO KEY UPDATE before the recheck, then runs the rechecked inner mutation, so this
 * read finds the row already held and a second request waits there instead of deadlocking.
 * Any other write that must update it does the same. A Person's row stays FOR SHARE: a
 * community ban reads its target's row FOR SHARE after locking the community, which a
 * stronger lock here would turn into a cycle.
 *
 * One exception to FOR SHARE: a remote community acting as itself (actorId is the community
 * its own Announce names) is also the community row every policy then locks FOR NO KEY
 * UPDATE (state.ts). Two such requests holding it FOR SHARE would each wait for the other to
 * upgrade (40P01), so that row is read FOR NO KEY UPDATE from the start.
 * Lane MODF adds the site-ban check here.
 */
export async function currentPrincipal(
  q: Queryable,
  principal: ActingPrincipal,
): Promise<{ ok: true; principal: ActingPrincipal } | { ok: false; reason: RefusalReason }> {
  const actsAsCommunity = principal.kind === 'remote' && principal.announcedBy?.communityId === principal.actorId;
  const [actor] = await q
    .select({ kind: actors.kind, local: actors.local, deletedAt: actors.deletedAt, userId: actors.userId })
    .from(actors)
    .where(eq(actors.id, principal.actorId))
    .for(actsAsCommunity ? 'no key update' : 'share');
  if (!actor) return { ok: false, reason: 'auth.required' };
  if (actor.deletedAt) return { ok: false, reason: 'auth.actor_deleted' };
  switch (principal.kind) {
    case 'remote':
      return actor.local ? { ok: false, reason: 'auth.required' } : { ok: true, principal };
    case 'system':
      return actor.local && actor.kind === 'Application' ? { ok: true, principal } : { ok: false, reason: 'auth.required' };
    case 'local': {
      if (!actor.local || actor.kind !== 'Person') return { ok: false, reason: 'auth.required' };
      const [user] = actor.userId
        ? await q
            .select({ role: authUser.role, twoFactorEnabled: authUser.twoFactorEnabled })
            .from(authUser)
            .where(eq(authUser.id, actor.userId))
            .for('share')
        : [];
      const siteRole = user?.role === 'admin' && user.twoFactorEnabled === true ? 'admin' : 'user';
      return { ok: true, principal: { ...principal, siteRole } };
    }
  }
}
