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
 * role comes from auth_user.role, not the session. Rows are read FOR SHARE so a concurrent
 * demotion or deletion waits for the write. Lane MODF adds the site-ban check here.
 */
export async function currentPrincipal(
  q: Queryable,
  principal: ActingPrincipal,
): Promise<{ ok: true; principal: ActingPrincipal } | { ok: false; reason: RefusalReason }> {
  const [actor] = await q
    .select({ kind: actors.kind, local: actors.local, deletedAt: actors.deletedAt, userId: actors.userId })
    .from(actors)
    .where(eq(actors.id, principal.actorId))
    .for('share');
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
        ? await q.select({ role: authUser.role }).from(authUser).where(eq(authUser.id, actor.userId)).for('share')
        : [];
      return { ok: true, principal: { ...principal, siteRole: user?.role === 'admin' ? 'admin' : 'user' } };
    }
  }
}
