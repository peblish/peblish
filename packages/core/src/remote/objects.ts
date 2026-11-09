import { and, eq, isNull } from 'drizzle-orm';
import { comments, posts } from '../db/tables/content.ts';
import { defineMutation } from '../tx/mutation.ts';
import { recordDeletion } from './ledger.ts';
import { objectRechecks } from './tables.ts';

// Owned by lane REM. A remote post or comment whose own server no longer serves it: the refetch
// answered 410 Gone or a Tombstone (federation/src/remote-fetch). The object's author deleting
// it arrives as a Delete activity instead and goes through deletePost and deleteComment.

/**
 * Soft-deletes the remote post or comment at the grant's ap_id (the row, its ap_id and its
 * replies stay, as for an author's delete) and records it in `deletion_ledger`, so a backup
 * restore re-applies it. Emits post.deleted or comment.deleted with `local: false`. A local
 * object is never touched here, and nothing happens, nothing is recorded, for an object we do
 * not hold or one already deleted. Its recheck mark (remote/rechecks.ts) goes with it.
 */
export const deleteRemoteObject = defineMutation({
  action: 'remote.object_delete',
  emits: ['post.deleted', 'comment.deleted'],
  async run(t, grant, _input: void) {
    const { apId } = grant.subject;
    const now = new Date();
    const [post] = await t.db
      .select({ id: posts.id, communityId: posts.communityId, authorId: posts.authorId, deletedAt: posts.deletedAt })
      .from(posts)
      .where(and(eq(posts.apId, apId), eq(posts.local, false)))
      .for('no key update');
    if (post) {
      if (post.deletedAt) return { deleted: false };
      await t.db.update(posts).set({ deletedAt: now }).where(eq(posts.id, post.id));
      await t.db.delete(objectRechecks).where(eq(objectRechecks.objectId, post.id));
      await recordDeletion(t, { kind: 'post', id: post.id, cause: 'Tombstone', actorId: grant.actorId });
      await t.emit({ type: 'post.deleted', v: 1, postId: post.id, communityId: post.communityId, authorId: post.authorId, local: false });
      return { deleted: true };
    }
    const [comment] = await t.db
      .select({ id: comments.id, postId: comments.postId, authorId: comments.authorId, deletedAt: comments.deletedAt })
      .from(comments)
      .where(and(eq(comments.apId, apId), eq(comments.local, false), isNull(comments.deletedAt)))
      .for('no key update');
    if (!comment) return { deleted: false };
    await t.db.update(comments).set({ deletedAt: now }).where(eq(comments.id, comment.id));
    await t.db.delete(objectRechecks).where(eq(objectRechecks.objectId, comment.id));
    await recordDeletion(t, { kind: 'comment', id: comment.id, cause: 'Tombstone', actorId: grant.actorId });
    await t.emit({
      type: 'comment.deleted',
      v: 1,
      commentId: comment.id,
      postId: comment.postId,
      authorId: comment.authorId,
      local: false,
    });
    return { deleted: true };
  },
});
