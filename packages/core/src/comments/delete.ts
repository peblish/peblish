import { eq } from 'drizzle-orm';
import { comments } from '../db/tables/content.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';

/**
 * The author's delete of their own comment (local, or a peer's Delete of a remote author's). A
 * delete is soft: the row stays with its ap_id, its path and its replies, which keep their
 * place under a tombstone (the read model withholds the text). The counts do not change: they
 * count every comment of the thread, tombstones included. A moderator's removal is mod.remove
 * (lane AZ), a different state with its own restore.
 */
export const deleteComment = defineMutation({
  action: 'comment.delete',
  emits: ['comment.deleted'],
  recheck: true,
  async run(t, grant, _input: void) {
    const [comment] = await t.db
      .update(comments)
      .set({ deletedAt: new Date() })
      .where(eq(comments.id, grant.subject.commentId))
      .returning({ postId: comments.postId, authorId: comments.authorId, local: comments.local });
    if (!comment) throw new Refused('comment.delete', 'target.not_found');
    await t.emit({ type: 'comment.deleted', v: 1, commentId: grant.subject.commentId, ...comment });
  },
});
