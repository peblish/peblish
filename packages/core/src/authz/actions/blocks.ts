import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { authUser } from '../../db/tables/auth.ts';
import { instances } from '../../db/tables/instances.ts';
import { allow, deny, forShare, type PolicyRequest } from '../policy.ts';
import { communityDenial, communityState } from '../state.ts';

// Owned by lane E1: a local person blocks or unblocks a person, a community or an instance.
// A block revokes nothing from anyone, so neither mutation rechecks and the reads take only
// FOR SHARE (the insert's foreign key takes the same lock on the target anyway).

/** What a block names: a person or a community by actor id, an instance by its id. */
export type BlockTarget = { kind: 'person'; actorId: Uuid } | { kind: 'community'; actorId: Uuid } | { kind: 'instance'; instanceId: Uuid };

export const policies = {
  /**
   * A signed-in local person blocks a target. A person must exist, not be deleted, and not be
   * themselves, the instance actor or a site admin; a community must be open; an instance must
   * not be this one.
   */
  'block.add': async ({ principal, subject, db, lock }: PolicyRequest<{ target: BlockTarget }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    const { target } = subject;
    const authority = (communityId: Uuid | null) => allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId });

    if (target.kind === 'instance') {
      const [instance] = await forShare(
        db.select({ local: instances.local }).from(instances).where(eq(instances.id, target.instanceId)),
        lock,
      );
      if (!instance) return deny('target.not_found');
      return instance.local ? deny('block.own_instance') : authority(null);
    }

    if (target.kind === 'community') {
      const community = await communityState({ db, lock }, target.actorId);
      if (!community) return deny('target.not_found');
      return communityDenial(community) ?? authority(community.id);
    }

    const [person] = await forShare(
      db
        .select({ id: actors.id, kind: actors.kind, deletedAt: actors.deletedAt, userId: actors.userId })
        .from(actors)
        .where(eq(actors.id, target.actorId)),
      lock,
    );
    if (!person || person.kind === 'Group') return deny('target.not_found');
    if (person.deletedAt) return deny('target.deleted');
    if (person.id === principal.actorId || person.kind === 'Application') return deny('target.protected');
    if (person.userId) {
      const [user] = await forShare(db.select({ role: authUser.role }).from(authUser).where(eq(authUser.id, person.userId)), lock);
      if (user?.role === 'admin') return deny('target.protected');
    }
    return authority(null);
  },

  /** A signed-in local person lifts one of their own blocks; a block that is not there is fine. */
  'block.remove': async ({ principal }: PolicyRequest<{ target: BlockTarget }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    return allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: null });
  },
};
