import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { authorize } from '../authz/authorize.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { removeFollow, requestFollow } from './follow.ts';

// Following as web calls it (Join and Leave on the community page and the directory):
// authorize, run the mutation, and answer with a result, a refusal from the precheck or from
// the recheck inside the transaction alike.

/** Joins a community: accepted at once for a local one, pending until the Accept for a remote one. Joining twice changes nothing. */
export async function followAs(
  principal: Principal,
  communityId: Uuid,
): Promise<Result<{ state: 'pending' | 'accepted'; created: boolean }>> {
  const decision = await authorize('follow.request', principal, { communityId });
  if (!decision.ok) return decision;
  return refusedAsResult(async () => {
    const { state, created } = await requestFollow(decision.grant);
    return { state, created };
  });
}

/** Leaves a community, or cancels a pending Follow; a remote community is sent Undo(Follow). Not following is `target.not_found`. */
export async function unfollowAs(principal: Principal, communityId: Uuid): Promise<Result<{ removed: boolean }>> {
  if (principal.kind === 'anonymous') return { ok: false, reason: 'auth.required' };
  const decision = await authorize('follow.remove', principal, { followerId: principal.actorId, followeeId: communityId, apId: null });
  if (!decision.ok) return decision;
  return refusedAsResult(() => removeFollow(decision.grant));
}
