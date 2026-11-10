import { eq } from 'drizzle-orm';
import { instances } from '../../db/tables/instances.ts';
import { allow, deny, forShare, type PolicyRequest } from '../policy.ts';

// Lane MODF: what the admin does about a peer (M18). Only a two-factor admin may, and the instance
// itself while importing (the feddit.com cutover carries PieFed's banned instances over as blocks,
// tools/cutover); the instance row is read FOR SHARE (updatePeer creates it for an unseen host and
// never updates it). No policy reads peer_controls, so the gates in peers/gate.ts need no lock.

/** A lowercase host (with an optional port) that reads back unchanged from a URL. */
export function isPeerDomain(domain: string): boolean {
  return /^[a-z0-9.-]+(:\d{1,5})?$/.test(domain) && domain.includes('.') && URL.parse(`https://${domain}`)?.host === domain;
}

async function peerUpdate({ principal, subject, db, lock }: PolicyRequest<{ domain: string }>) {
  const importing = principal.kind === 'system' && principal.job === 'import';
  if (!importing && (principal.kind !== 'local' || principal.siteRole !== 'admin')) return deny('auth.admin_required');
  if (!isPeerDomain(subject.domain)) return deny('peer.invalid_domain');
  const [instance] = await forShare(
    db.select({ local: instances.local }).from(instances).where(eq(instances.domain, subject.domain)),
    lock,
  );
  if (instance?.local) return deny('peer.local_instance');
  return importing
    ? allow({ kind: 'system', actorId: principal.actorId, job: 'import', ref: null })
    : allow({ kind: 'site-admin', actorId: principal.actorId });
}

export const policies = {
  'peer.update': peerUpdate,
};
