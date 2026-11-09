import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { ModInput } from '@peblish/schema/modlog';
import { and, eq } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { moderatorCache } from '../authz/moderators-cache.ts';
import { communityState } from '../authz/state.ts';
import { actors } from '../db/tables/actors.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { isLocal, locked, moderationInput, vanished } from '../moderation/shared.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation } from '../tx/mutation.ts';

/**
 * Makes `actorId` an owner or a moderator of the community, or removes them (role null), and
 * logs it. The grant's subject names the community, the actor and the role, so a grant to
 * appoint a moderator cannot make an owner. The row is local, confirmed now and without an
 * expiry. mod.role makes the worker drop the cached role (authz/consumer.ts); the policy read
 * the row FOR NO KEY UPDATE after the community's actor row, so this write waits for nobody.
 */
export const setModerator = defineMutation({
  action: 'community.set_moderator',
  emits: ['mod.role'],
  recheck: true,
  async run(t, grant, input: ModInput) {
    const { reason, activityApId, details } = moderationInput(input);
    const { communityId, actorId, role } = grant.subject;
    const community = await communityState(locked(t.db), communityId);
    const [target] = await t.db.select({ apId: actors.apId }).from(actors).where(eq(actors.id, actorId));
    if (!community || !target) throw vanished(`moderator ${actorId} of ${communityId}`);
    if (role === null) {
      await t.db
        .delete(communityModerators)
        .where(and(eq(communityModerators.communityId, communityId), eq(communityModerators.moderatorId, actorId)));
    } else {
      const row = { role, source: 'local', verifiedAt: new Date(), expiresAt: null } as const;
      await t.db
        .insert(communityModerators)
        .values({ communityId, moderatorId: actorId, ...row })
        .onConflictDoUpdate({ target: [communityModerators.communityId, communityModerators.moderatorId], set: row });
    }
    const modlogId = await writeModlog(t.db, grant, { community, target: { actorId, apId: target.apId }, reason, details, activityApId });
    await t.emit({
      type: 'mod.role',
      v: 1,
      modlogId,
      moderatorId: grant.actorId,
      local: isLocal(grant.principal),
      communityId,
      actorId,
      role,
    });
    return { modlogId };
  },
});

/**
 * community.set_moderator for web. The web process also forgets the cached role at once; the
 * worker's consumer does the same for its own cache, and other processes wait out the TTL.
 */
export async function setModeratorAs(
  principal: Principal,
  subject: { communityId: Uuid; actorId: Uuid; role: 'owner' | 'moderator' | null },
  input: ModInput = {},
): Promise<Result<{ modlogId: Uuid }>> {
  const decision = await authorize('community.set_moderator', principal, subject);
  if (!decision.ok) return decision;
  const result = await refusedAsResult(() => setModerator(decision.grant, input));
  if (result.ok) moderatorCache().forget(subject.communityId, subject.actorId);
  return result;
}
