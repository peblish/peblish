import { eq } from 'drizzle-orm';
import { comments } from '../db/tables/content.ts';
import type { WriteTx } from '../db/write.ts';
import { olderThanHeld } from '../remote/revision.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';

// The author's delete of their own comment (local, or a peer's Delete of a remote author's) and
// the undo of it (the author's restore, or a peer's Undo(Delete)). A delete is soft: the row
// stays with its ap_id, its path and its replies, which keep their place under a tombstone (the
// read model withholds the text). Neither changes a count: they count every comment of the
// thread, tombstones included, so a restore has nothing to put back. A moderator's removal is
// mod.remove (lane AZ), a different state with its own restore.

async function setDeleted(t: WriteTx, commentId: string, deleted: boolean, action: 'comment.delete' | 'comment.restore') {
  const [comment] = await t
    .update(comments)
    .set({ deletedAt: deleted ? new Date() : null })
    .where(eq(comments.id, commentId))
    .returning({ postId: comments.postId, authorId: comments.authorId, local: comments.local });
  if (!comment) throw new Refused(action, 'target.not_found');
  return { commentId, ...comment };
}

/**
 * `revision`: the peer revision this delete answers (a withdrawing Update's `updated`). When it
 * is older than the comment's edit time (olderThanHeld) the comment is left as it is and this
 * returns false. It is judged here, on the rows the recheck has just locked in the codebase's one
 * order (community, then post, then comment: authz/state.ts), so it needs no lock of its own.
 */
export const deleteComment = defineMutation({
  action: 'comment.delete',
  emits: ['comment.deleted'],
  recheck: true,
  async run(t, grant, input: { revision: Date | null } | void): Promise<boolean> {
    const { commentId } = grant.subject;
    if (input) {
      const [held] = await t.db.select({ editedAt: comments.editedAt }).from(comments).where(eq(comments.id, commentId));
      if (olderThanHeld(input.revision, held?.editedAt ?? null)) return false;
    }
    await t.emit({ type: 'comment.deleted', v: 1, ...(await setDeleted(t.db, commentId, true, 'comment.delete')) });
    return true;
  },
});

/** The author's undo of their delete. FED-B calls it for a peer's Undo(Delete) of a comment. */
export const restoreComment = defineMutation({
  action: 'comment.restore',
  emits: ['comment.restored'],
  recheck: true,
  async run(t, grant, _input: void) {
    await t.emit({ type: 'comment.restored', v: 1, ...(await setDeleted(t.db, grant.subject.commentId, false, 'comment.restore')) });
  },
});
