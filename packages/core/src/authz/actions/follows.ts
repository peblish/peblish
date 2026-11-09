import type { Uuid } from '@peblish/schema/ids';
import { and, eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { follows } from '../../db/tables/follows.ts';
import { allow, deny, forNoKeyUpdate, type PolicyRequest } from '../policy.ts';
import { communityDenial, communityState, isBanned } from '../state.ts';

// Owned by lane FED-A: follows (a local actor follows a community, a remote actor follows ours,
// the answers that come back). Lock order as everywhere: the acting actor, then the community's
// actor row (communityState takes it), then the follow row; a body updates or deletes the
// follow row, so the policies read it FOR NO KEY UPDATE.

export const policies = {
  /** A signed-in local person follows a community: it exists, is not removed, and the person is not banned from it. */
  'follow.request': async ({ principal, subject, db, lock }: PolicyRequest<{ communityId: Uuid }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    const community = await communityState({ db, lock }, subject.communityId);
    if (!community) return deny('target.not_found');
    const closed = communityDenial(community);
    if (closed) return closed;
    if (await isBanned({ db, lock }, subject.communityId, principal.actorId)) return deny('community.banned');
    return allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: subject.communityId });
  },

  /**
   * A local actor stops following (principal local, the follower), an Undo(Follow) arrives from
   * the follower, or a Reject arrives from the followee (principal remote, either). `apId`, when
   * given, is the Follow id the activity names and must be the stored one (the slice 3 hardening:
   * a Reject deletes only the follow it names).
   */
  'follow.remove': async ({ principal, subject, db, lock }: PolicyRequest<{ followerId: Uuid; followeeId: Uuid; apId: string | null }>) => {
    if (principal.kind !== 'local' && principal.kind !== 'remote') return deny('auth.required');
    if (principal.actorId !== subject.followerId && !(principal.kind === 'remote' && principal.actorId === subject.followeeId)) {
      return deny('follow.mismatch');
    }
    const [row] = await forNoKeyUpdate(
      db
        .select({ apId: follows.apId })
        .from(follows)
        .where(and(eq(follows.followerId, subject.followerId), eq(follows.followeeId, subject.followeeId))),
      lock,
    );
    if (!row) return deny('target.not_found');
    if (subject.apId !== null && row.apId !== subject.apId) return deny('follow.mismatch');
    return allow({ kind: 'owner', actorId: principal.actorId });
  },

  /**
   * A remote community accepts a Follow of ours. The Follow id, the follower (local) and the
   * community (the acting principal) must all match the stored pending or accepted row.
   */
  'follow.accept': async ({ principal, subject, db, lock }: PolicyRequest<{ followApId: string }>) => {
    if (principal.kind !== 'remote') return deny('auth.required');
    const [row] = await forNoKeyUpdate(
      db
        .select({ followeeId: follows.followeeId, followerLocal: actors.local })
        .from(follows)
        .innerJoin(actors, eq(actors.id, follows.followerId))
        .where(eq(follows.apId, subject.followApId)),
      lock,
    );
    if (!row) return deny('target.not_found');
    if (row.followeeId !== principal.actorId || !row.followerLocal) return deny('follow.mismatch');
    return allow({ kind: 'owner', actorId: principal.actorId });
  },

  /** A remote actor follows a local community: the community is local, open to them, and they are not banned from it. */
  'follow.receive': async ({ principal, subject, db, lock }: PolicyRequest<{ communityId: Uuid; followApId: string }>) => {
    if (principal.kind !== 'remote') return deny('auth.required');
    const community = await communityState({ db, lock }, subject.communityId);
    if (!community?.local) return deny('target.not_found');
    const closed = communityDenial(community);
    if (closed) return closed;
    if (await isBanned({ db, lock }, subject.communityId, principal.actorId)) return deny('community.banned');
    return allow({ kind: 'owner', actorId: principal.actorId });
  },

  /** The scheduled job sends an unanswered Follow again: the follow must still be pending. */
  'follow.retry': async ({ principal, subject, db, lock }: PolicyRequest<{ followId: Uuid }>) => {
    if (principal.kind !== 'system' || principal.job !== 'scheduled') return deny('auth.required');
    const [row] = await forNoKeyUpdate(db.select({ state: follows.state }).from(follows).where(eq(follows.id, subject.followId)), lock);
    if (!row) return deny('target.not_found');
    if (row.state !== 'pending') return deny('follow.not_pending');
    return allow({ kind: 'system', actorId: principal.actorId, job: 'scheduled', ref: subject.followId });
  },
};
