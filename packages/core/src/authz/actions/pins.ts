import type { Uuid } from '@peblish/schema/ids';
import { and, eq } from 'drizzle-orm';
import { blockedAmong } from '../../blocks/predicate.ts';
import { follows } from '../../db/tables/follows.ts';
import { allow, deny, forShare, type PolicyRequest } from '../policy.ts';
import { communityDenial, communityState } from '../state.ts';

// Owned by lane f-pins (branch 5): a signed-in local person pins, unpins and reorders the
// communities in their own sidebar. Owner-only: the owner is always the principal, the subject
// only names the community. Lock order as for follows: the acting actor (the recheck's principal
// refresh), then the community's actor row (communityState), then the follow row, read FOR SHARE
// since no pin write updates it. The mutations take a per-owner advisory lock before all of these.

const own = (actorId: Uuid) => allow({ kind: 'owner', actorId });

export const policies = {
  /**
   * Pin a community: an open one the person follows, accepted or still pending, and does not
   * block (itself or its instance; a pin made before the block is kept but hidden, pins/shown.ts).
   */
  'pin.add': async ({ principal, subject, db, lock }: PolicyRequest<{ communityId: Uuid }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    const community = await communityState({ db, lock }, subject.communityId);
    if (!community) return deny('target.not_found');
    const closed = communityDenial(community);
    if (closed) return closed;
    if ((await blockedAmong(db, principal.actorId, [subject.communityId])).size > 0) return deny('target.not_found');
    const [follow] = await forShare(
      db
        .select({ state: follows.state })
        .from(follows)
        .where(and(eq(follows.followerId, principal.actorId), eq(follows.followeeId, subject.communityId))),
      lock,
    );
    return follow ? own(principal.actorId) : deny('pin.not_followed');
  },

  /** Unpin one of the person's own pins; a pin that is not there is fine. */
  'pin.remove': async ({ principal }: PolicyRequest<{ communityId: Uuid }>) =>
    principal.kind === 'local' ? own(principal.actorId) : deny('auth.required'),

  /** Move one of the person's own pins; the mutation finds it (or refuses) under the owner's lock. */
  'pin.move': async ({ principal }: PolicyRequest<{ communityId: Uuid }>) =>
    principal.kind === 'local' ? own(principal.actorId) : deny('auth.required'),
};
