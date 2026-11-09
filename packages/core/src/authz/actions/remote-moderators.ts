import type { Uuid } from '@peblish/schema/ids';
import { deny, allow, type PolicyRequest } from '../policy.ts';
import { communityDenial, communityState } from '../state.ts';

// Owned by lane FED-B (REM inherits it). The mirror of a remote community's moderators
// collection is written by the instance itself after federation fetched and checked the
// collection (inbound/moderators/refresh.ts), never on a person's behalf. The community row is
// read (and, under lock, taken FOR NO KEY UPDATE) first, as every writer of moderator rows
// does (state.ts lock order), so a mirror and a rechecked write in the community take turns.

export const policies = {
  /** Mirror the moderators of a remote community that is neither deleted nor removed. */
  'remote.moderators_mirror': async ({ principal, subject, db, lock }: PolicyRequest<{ communityId: Uuid }>) => {
    if (principal.kind !== 'system' || principal.job !== 'import') return deny('auth.required');
    const community = await communityState({ db, lock }, subject.communityId);
    // A local community's moderators are its own table (community.set_moderator); only a peer's are mirrored.
    if (!community || community.local) return deny('target.not_found');
    const closed = communityDenial(community);
    if (closed) return closed;
    return allow({ kind: 'system', actorId: principal.actorId, job: 'import', ref: null });
  },
};
