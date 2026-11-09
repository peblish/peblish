import { eq } from 'drizzle-orm';
import { posts } from '../db/tables/content.ts';
import type { WriteTx } from '../db/write.ts';
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

export const deletePost = defineMutation({
  action: 'post.delete',
  emits: ['post.deleted'],
  recheck: true,
  async run(t, grant, _input: void) {
    await t.emit({ type: 'post.deleted', v: 1, ...(await setDeleted(t.db, grant.subject.postId, true, 'post.delete')) });
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
