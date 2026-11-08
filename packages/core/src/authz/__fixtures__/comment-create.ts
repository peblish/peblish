import type { Uuid } from '@peblish/schema/ids';
import { allow, deny, type PolicyRequest, type PolicyResult } from '../policy.ts';
import { commentingDenial, postState } from '../state.ts';

// Test only, never registered (fixtures are outside the policy glob): the shape lane D's
// comment.create policy takes. It calls state.ts's commentingDenial before any locked read of
// its own, then builds its authority from the post's community.
export async function commentCreate(request: PolicyRequest<{ postId: Uuid; parentId: Uuid | null }>): Promise<PolicyResult> {
  const { principal, subject } = request;
  if (principal.kind !== 'local') return deny('auth.required');
  const denied = await commentingDenial(request, principal.actorId, subject);
  if (denied) return denied;
  const post = await postState(request, subject.postId);
  if (!post) return deny('target.not_found');
  return allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: post.community.id });
}
