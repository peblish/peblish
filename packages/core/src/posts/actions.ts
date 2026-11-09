import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { authorize } from '../authz/authorize.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { voteAs } from '../votes/service.ts';
import { createPost } from './create.ts';
import { deletePost, restorePost } from './delete.ts';
import { updatePost } from './edit.ts';
import type { NewPost, PostEdit } from './input.ts';

// The post actions as web calls them: authorize, run the mutation, and answer with a result,
// a refusal from the precheck or from the recheck inside the transaction alike (the page maps
// the reason to a message). Callers validate the input first with NewPost and PostEdit
// (./input.ts) to show field errors; the mutations assert it again.

/**
 * Creates the post, then casts the author's own upvote on it, as Lemmy and PieFed do, so a new
 * post starts at a score of 1 like its peers'. The vote is a second mutation and best effort: the
 * post exists either way, so a refusal or a failure there is not the caller's error, only a warning.
 */
export async function createPostAs(principal: Principal, communityId: Uuid, input: NewPost): Promise<Result<{ id: Uuid; apId: string }>> {
  const decision = await authorize('post.create', principal, { communityId });
  if (!decision.ok) return decision;
  const created = await refusedAsResult(() => createPost(decision.grant, input));
  if (created.ok) {
    try {
      const voted = await voteAs(principal, { kind: 'post', id: created.id }, 1);
      if (!voted.ok) console.warn(`createPostAs: the author's upvote on post ${created.id} was refused: ${voted.reason}`);
    } catch (error) {
      console.warn(`createPostAs: the author's upvote on post ${created.id} failed`, error);
    }
  }
  return created;
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
