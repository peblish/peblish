import type { ActingPrincipal } from '@peblish/schema/authz';
import { eq } from 'drizzle-orm';
import type { Queryable } from '../../db/read.ts';
import { actors } from '../../db/tables/actors.ts';
import { authUser } from '../../db/tables/auth.ts';
import type { Frozen } from '../frozen.ts';
import { allow, deny, forShare, type PolicyRequest, type PolicyResult } from '../policy.ts';

// Owned by lane ADM: site settings and CMS pages. Only an admin with two-factor writes either.
// Under lock the admin's login row is read FOR SHARE, as lane A's and F's admin policies do; no
// write body here updates it. The setting rows a write changes are locked by the write itself
// (settings/write.ts), which is what makes a flip wait for a reader holding the row FOR SHARE.

/** A site admin with two-factor on, as lane A's admin policies decide it; the deny, or null. */
export async function denyUnlessAdmin(principal: Frozen<ActingPrincipal>, db: Queryable, lock: boolean): Promise<PolicyResult | null> {
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

export const policies = {
  /** An admin with two-factor changes site settings. The subject names the keys, which the body takes from the grant. */
  'settings.update': async ({ principal, db, lock }: PolicyRequest<{ keys: string[] }>) =>
    (await denyUnlessAdmin(principal, db, lock)) ?? allow({ kind: 'site-admin', actorId: principal.actorId }),
};
