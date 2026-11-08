import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { allow, deny, type PolicyRequest } from '../policy.ts';

// Stub owned by lane MODF: site-level ban and unban of a local or remote actor (M06).
// Community-scope moderation (remove, restore, lock, pin, community ban) lives in
// actions/moderation.ts, owned by lane AZ. Both emit mod.ban (communityId null here).

async function siteAdminOver({ principal, subject, db }: PolicyRequest<{ targetActorId: Uuid }>) {
  if (principal.kind !== 'local' || principal.siteRole !== 'admin') return deny('auth.admin_required');
  const [target] = await db.select({ id: actors.id }).from(actors).where(eq(actors.id, subject.targetActorId));
  if (!target) return deny('target.not_found');
  return allow({ kind: 'site-admin', actorId: principal.actorId });
}

export const policies = {
  'mod.site_ban': siteAdminOver,
  'mod.site_unban': siteAdminOver,
};
