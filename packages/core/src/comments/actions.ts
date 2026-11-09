import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { authorize } from '../authz/authorize.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { voteAs } from '../votes/service.ts';
import { createComment } from './create.ts';
import { deleteComment } from './delete.ts';
import { updateComment } from './edit.ts';
import type { CommentEdit, NewComment } from './input.ts';

// The comment actions as web calls them: authorize, run the mutation, and answer with a result,
// a refusal from the precheck or from the recheck inside the transaction alike (the page maps
// the reason to a message). Callers validate the input first with NewComment and CommentEdit
// (./input.ts) to show field errors; the mutations assert it again.

/**
 * Comments on the post, or replies to `parentId`. Then casts the author's own upvote on it, as
 * Lemmy and PieFed do, so a new comment starts at a score of 1 like its peers'. The vote is a
 * second mutation and best effort: the comment exists either way, so a refusal or a failure
 * there is not the caller's error.
 */
export async function createCommentAs(
  principal: Principal,
  where: { postId: Uuid; parentId: Uuid | null },
  input: NewComment,
): Promise<Result<{ id: Uuid; apId: string }>> {
  const decision = await authorize('comment.create', principal, where);
  if (!decision.ok) return decision;
  const created = await refusedAsResult(() => createComment(decision.grant, input));
  if (created.ok) await voteAs(principal, { kind: 'comment', id: created.id }, 1).catch(() => undefined);
  return created;
}

/** `changed` is false when the edit changed nothing. */
export async function updateCommentAs(principal: Principal, commentId: Uuid, edit: CommentEdit): Promise<Result<{ changed: boolean }>> {
  const decision = await authorize('comment.update', principal, { commentId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => updateComment(decision.grant, edit));
}

export async function deleteCommentAs(principal: Principal, commentId: Uuid): Promise<Result<object>> {
  const decision = await authorize('comment.delete', principal, { commentId });
  if (!decision.ok) return decision;
  return refusedAsResult(async () => (await deleteComment(decision.grant), {}));
}
