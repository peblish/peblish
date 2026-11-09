import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { authUser } from '../../db/tables/auth.ts';
import { allow, deny, forNoKeyUpdate, forShare, type PolicyRequest } from '../policy.ts';

// Stub owned by lane MODF: site-level ban and unban of a local or remote actor (M06).
// Community-scope moderation (remove, restore, lock, pin, community ban) lives in
// actions/moderation.ts, owned by lane AZ. Both emit mod.ban (communityId null here).

async function siteAdminOver({ principal, subject, db, lock }: PolicyRequest<{ targetActorId: Uuid }>) {
  if (principal.kind !== 'local' || principal.siteRole !== 'admin') return deny('auth.admin_required');
  // FOR NO KEY UPDATE on the target actor row: the ban mutation locks it the same way before
  // inserting the ban, and the banned actor's own rechecked writes lock it in the principal
  // refresh (PolicyRequest.lock).
  const [target] = await forNoKeyUpdate(
    db
      .select({ id: actors.id, kind: actors.kind, local: actors.local, userId: actors.userId })
      .from(actors)
      .where(eq(actors.id, subject.targetActorId)),
    lock,
  );
  if (!target) return deny('target.not_found');
  if (target.id === principal.actorId || (target.local && target.kind === 'Application')) return deny('target.protected');
  if (target.userId) {
    const [user] = await forShare(db.select({ role: authUser.role }).from(authUser).where(eq(authUser.id, target.userId)), lock);
    if (user?.role === 'admin') return deny('target.protected');
  }
  return allow({ kind: 'site-admin', actorId: principal.actorId });
}

export const policies = {
  'mod.site_ban': siteAdminOver,
  'mod.site_unban': siteAdminOver,
};
