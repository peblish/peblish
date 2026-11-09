import type { ActingPrincipal } from '@peblish/schema/authz';
import { eq } from 'drizzle-orm';
import type { Queryable } from '../../db/read.ts';
import { actors } from '../../db/tables/actors.ts';
import { authUser } from '../../db/tables/auth.ts';
import { switchedOn } from '../../media/settings.ts';
import type { Frozen } from '../frozen.ts';
import { allow, deny, forShare, type PolicyRequest, type PolicyResult } from '../policy.ts';

// Owned by lane B2. Two ways a local account puts an image in the bucket: an upload (switched
// off by uploads.enabled until M26 scanning is live, decision 4) and the thumbnail of a link
// preview (switched off by remote_media.enabled, which also stops the fetch). Both need a
// verified email, like posting does. Under lock the setting row and the login row are read
// FOR SHARE; no write body updates either.

async function mediaDenial(
  principal: Frozen<ActingPrincipal>,
  db: Queryable,
  lock: boolean,
  setting: 'uploads.enabled' | 'remote_media.enabled',
): Promise<PolicyResult | null> {
  if (principal.kind !== 'local') return deny('auth.required');
  const [login] = await forShare(
    db
      .select({ emailVerified: authUser.emailVerified })
      .from(actors)
      .innerJoin(authUser, eq(authUser.id, actors.userId))
      .where(eq(actors.id, principal.actorId)),
    lock,
  );
  if (!login?.emailVerified) return deny('auth.email_unverified');
  if (!(await switchedOn(db, setting, lock))) return deny('site.disabled');
  return null;
}

// The subject is empty: the owner is the acting actor, and the object key is made by the service.
type NoSubject = Record<string, never>;

export const policies = {
  'media.upload': async ({ principal, db, lock }: PolicyRequest<NoSubject>) =>
    (await mediaDenial(principal, db, lock, 'uploads.enabled')) ??
    allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: null }),
  'media.thumbnail': async ({ principal, db, lock }: PolicyRequest<NoSubject>) =>
    (await mediaDenial(principal, db, lock, 'remote_media.enabled')) ??
    allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: null }),
};
