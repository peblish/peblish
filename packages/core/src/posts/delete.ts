import { eq } from 'drizzle-orm';
import { posts } from '../db/tables/content.ts';
import type { WriteTx } from '../db/write.ts';
import { olderThanHeld } from '../remote/revision.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';

// The author's delete and undo of it. A delete is soft: the row, its ap_id and its comments
// stay, so a peer's Delete or a link still finds a tombstone (readPost withholds the content).
// A moderator's removal is mod.remove (lane AZ), a different state with its own restore.

async function setDeleted(db: WriteTx, postId: string, deleted: boolean, action: 'post.delete' | 'post.restore') {
  const [post] = await db
    .update(posts)
    .set({ deletedAt: deleted ? new Date() : null })
    .where(eq(posts.id, postId))
    .returning({ communityId: posts.communityId, authorId: posts.authorId, local: posts.local });
  if (!post) throw new Refused(action, 'target.not_found');
  return { postId, ...post };
}

/**
 * `revision`: the peer revision this delete answers (a withdrawing Update's `updated`). When it
 * is older than the post's edit time (olderThanHeld) the post is left as it is and this returns
 * false. It is judged here, on the rows the recheck has just locked in the codebase's one order
 * (community, then post: authz/state.ts), so it needs no lock of its own.
 */
export const deletePost = defineMutation({
  action: 'post.delete',
  emits: ['post.deleted'],
  recheck: true,
  async run(t, grant, input: { revision: Date | null } | void): Promise<boolean> {
    const { postId } = grant.subject;
    if (input) {
      const [held] = await t.db.select({ editedAt: posts.editedAt }).from(posts).where(eq(posts.id, postId));
      if (olderThanHeld(input.revision, held?.editedAt ?? null)) return false;
    }
    await t.emit({ type: 'post.deleted', v: 1, ...(await setDeleted(t.db, postId, true, 'post.delete')) });
    return true;
  },
});

export const restorePost = defineMutation({
  action: 'post.restore',
  emits: ['post.restored'],
  recheck: true,
  async run(t, grant, _input: void) {
    await t.emit({ type: 'post.restored', v: 1, ...(await setDeleted(t.db, grant.subject.postId, false, 'post.restore')) });
  },
});
