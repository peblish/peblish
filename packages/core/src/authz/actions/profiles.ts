import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { allow, deny, forNoKeyUpdate, type PolicyRequest } from '../policy.ts';

// Owned by lane E1: a local person edits their own profile. The body updates the actor row, so
// the policy reads it FOR NO KEY UPDATE. Nothing is revoked by it, so there is no recheck.

export const policies = {
  'profile.update': async ({ principal, subject, db, lock }: PolicyRequest<{ actorId: Uuid }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    if (principal.actorId !== subject.actorId) return deny('profile.not_own');
    const [row] = await forNoKeyUpdate(db.select({ deletedAt: actors.deletedAt }).from(actors).where(eq(actors.id, subject.actorId)), lock);
    if (!row) return deny('target.not_found');
    if (row.deletedAt) return deny('target.deleted');
    return allow({ kind: 'owner', actorId: principal.actorId });
  },
};
