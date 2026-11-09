import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { media } from '../../db/tables/media.ts';
import { mediaBlocklist } from '../../mediascan/tables.ts';
import { allow, deny, forNoKeyUpdate, type PolicyRequest, type PolicyResult } from '../policy.ts';

// Owned by lane SAFE (wave 3): scanning, quarantine review and the blocked-image list.
//
// media.scan is the instance acting as itself (the scan, expiry and purge jobs, systemPrincipal
// 'scheduled'). media.review and media.blocklist are an admin's (role admin; two-factor is
// implied by SessionView.siteRole). Every mutation of these actions sets recheck: true. The
// media row each one changes is read FOR NO KEY UPDATE, since the body updates it: a scan
// result and an admin's decision on one image serialise on that row (state machine: state.ts).

type OnMedia = { mediaId: Uuid };

async function mediaExists({ subject, db, lock }: PolicyRequest<OnMedia>): Promise<PolicyResult | null> {
  const [row] = await forNoKeyUpdate(db.select({ id: media.id }).from(media).where(eq(media.id, subject.mediaId)), lock);
  return row ? null : deny('target.not_found');
}

const scheduled = ({ principal }: PolicyRequest<unknown>): PolicyResult =>
  principal.kind === 'system' && principal.job === 'scheduled'
    ? allow({ kind: 'system', actorId: principal.actorId, job: 'scheduled', ref: null })
    : deny('auth.required');

export const policies = {
  /** Leases pending rows for scanning: one named row (an upload's inline scan) or, with no id, the next due batch. */
  'media.scan_claim': async (request: PolicyRequest<{ mediaId: Uuid | null }>): Promise<PolicyResult> => {
    const decision = scheduled(request);
    const { mediaId } = request.subject;
    if (!decision.ok || mediaId === null) return decision;
    return (await mediaExists({ ...request, subject: { mediaId } })) ?? decision;
  },
  'media.scan': async (request: PolicyRequest<OnMedia>): Promise<PolicyResult> => {
    const denied = scheduled(request);
    return denied.ok ? ((await mediaExists(request)) ?? denied) : denied;
  },
  'media.review': async (request: PolicyRequest<OnMedia>): Promise<PolicyResult> => {
    const { principal } = request;
    if (principal.kind !== 'local' || principal.siteRole !== 'admin') return deny('auth.admin_required');
    return (await mediaExists(request)) ?? allow({ kind: 'site-admin', actorId: principal.actorId });
  },
  /** `entryId` is null when adding a hash and names the entry when removing one. */
  'media.blocklist': async ({ principal, subject, db, lock }: PolicyRequest<{ entryId: Uuid | null }>): Promise<PolicyResult> => {
    if (principal.kind !== 'local' || principal.siteRole !== 'admin') return deny('auth.admin_required');
    if (subject.entryId !== null) {
      const [entry] = await forNoKeyUpdate(
        db.select({ id: mediaBlocklist.id }).from(mediaBlocklist).where(eq(mediaBlocklist.id, subject.entryId)),
        lock,
      );
      if (!entry) return deny('target.not_found');
    }
    return allow({ kind: 'site-admin', actorId: principal.actorId });
  },
};
