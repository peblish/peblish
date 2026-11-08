import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { allow, deny, forNoKeyUpdate, type PolicyRequest } from '../policy.ts';
import { postingDenial } from '../state.ts';

// Owned by lane B1. Lane AZ's guard (authz/state.ts: postingDenial) refuses removed
// communities and community bans. Lane F adds postingRestrictedToMods later.
export const policies = {
  'post.create': async ({ principal, subject, db, lock }: PolicyRequest<{ communityId: Uuid }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    // FOR NO KEY UPDATE: post creation updates the community's counters (lane B1), and a
    // community ban recorded as an INSERT (lane AZ) locks this row first (PolicyRequest.lock).
    const [community] = await forNoKeyUpdate(
      db.select({ kind: actors.kind, deletedAt: actors.deletedAt }).from(actors).where(eq(actors.id, subject.communityId)),
      lock,
    );
    if (community?.kind !== 'Group') return deny('target.not_found');
    if (community.deletedAt) return deny('target.deleted');
    const denied = await postingDenial({ db, lock }, principal.actorId, subject.communityId);
    if (denied) return denied;
    return allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: subject.communityId });
  },
};
