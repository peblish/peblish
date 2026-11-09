import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { followAs, unfollowAs } from '../follows/service.ts';
import type { Result } from '../identity/result.ts';

// Join and Leave as the directory's buttons post them. They are the follow service's own calls
// (authorize `follow.request` or `follow.remove`, then the mutation), so every refusal, a ban or a
// removed community included, comes back with the reason the policy gave.

/** Joins the community: accepted at once for a local one, pending until the Accept for a remote one. */
export async function joinCommunityAs(principal: Principal, communityId: Uuid): Promise<Result<{ state: 'pending' | 'accepted' }>> {
  const result = await followAs(principal, communityId);
  return result.ok ? { ok: true, state: result.state } : result;
}

/** Leaves the community, or cancels a pending join. Not joined is `target.not_found`. */
export async function leaveCommunityAs(principal: Principal, communityId: Uuid): Promise<Result<object>> {
  const result = await unfollowAs(principal, communityId);
  return result.ok ? { ok: true } : result;
}
