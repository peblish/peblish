import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { authorize } from '../authz/authorize.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { removeContent, restoreContent } from '../moderation/remove.ts';
import { createPost } from './create.ts';
import { deletePost, restorePost } from './delete.ts';
import { updatePost } from './edit.ts';
import type { NewPost, PostEdit } from './input.ts';

// The post actions as web calls them: authorize, run the mutation, and answer with a result,
// a refusal from the precheck or from the recheck inside the transaction alike (the page maps
// the reason to a message). Callers validate the input first with NewPost and PostEdit
// (./input.ts) to show field errors; the mutations assert it again.

export async function createPostAs(principal: Principal, communityId: Uuid, input: NewPost): Promise<Result<{ id: Uuid; apId: string }>> {
  const decision = await authorize('post.create', principal, { communityId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => createPost(decision.grant, input));
}

/** `changed` is false when the edit changed nothing. */
export async function updatePostAs(principal: Principal, postId: Uuid, edit: PostEdit): Promise<Result<{ changed: boolean }>> {
  const decision = await authorize('post.update', principal, { postId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => updatePost(decision.grant, edit));
}

export async function deletePostAs(principal: Principal, postId: Uuid): Promise<Result<object>> {
  const decision = await authorize('post.delete', principal, { postId });
  if (!decision.ok) return decision;
  return refusedAsResult(async () => (await deletePost(decision.grant), {}));
}

export async function restorePostAs(principal: Principal, postId: Uuid): Promise<Result<object>> {
  const decision = await authorize('post.restore', principal, { postId });
  if (!decision.ok) return decision;
  return refusedAsResult(async () => (await restorePost(decision.grant), {}));
}

/** A moderator's removal of a post (lane AZ's mod.remove), with the statement of reasons shown to its author. */
export async function removePostAs(principal: Principal, postId: Uuid, reason: string | null): Promise<Result<{ modlogId: Uuid }>> {
  const decision = await authorize('mod.remove', principal, { target: { kind: 'post', id: postId } });
  if (!decision.ok) return decision;
  return refusedAsResult(() => removeContent(decision.grant, { reason }));
}

/** A moderator's restore of a removed post (mod.restore). */
export async function restoreRemovedPostAs(principal: Principal, postId: Uuid, reason: string | null): Promise<Result<{ modlogId: Uuid }>> {
  const decision = await authorize('mod.restore', principal, { target: { kind: 'post', id: postId } });
  if (!decision.ok) return decision;
  return refusedAsResult(() => restoreContent(decision.grant, { reason }));
}
