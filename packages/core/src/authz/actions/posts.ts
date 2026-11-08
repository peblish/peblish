import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { allow, deny, forShare, type PolicyRequest } from '../policy.ts';

// Owned by lane B1 after G0. Lane AZ's guard seam is packages/core/src/authz/state.ts: AZ adds
// a single guard call line here and in votes.ts (bans, locks). Lane F adds
// postingRestrictedToMods later.
export const policies = {
  'post.create': async ({ principal, subject, db, lock }: PolicyRequest<{ communityId: Uuid }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    const [community] = await forShare(
      db.select({ kind: actors.kind, deletedAt: actors.deletedAt }).from(actors).where(eq(actors.id, subject.communityId)),
      lock,
    );
    if (community?.kind !== 'Group') return deny('target.not_found');
    if (community.deletedAt) return deny('target.deleted');
    return allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: subject.communityId });
  },
};
