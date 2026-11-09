import type { Uuid } from '@peblish/schema/ids';
import { eq, sql } from 'drizzle-orm';
import { comments, posts } from '../db/tables/content.ts';
import type { WriteTx } from '../db/write.ts';
import { Refused } from '../tx/refused.ts';
import { maxCommentDepth } from './input.ts';

/** The comment row a mutation inserts; the rest (path, counts) this file decides. */
export type NewCommentRow = Omit<typeof comments.$inferInsert, 'path' | 'parentId' | 'postId'> & { id: Uuid };

/** A path label is the comment's id: ltree allows the hyphens of a uuid (PostgreSQL 16 and later). */
const label = (id: string) => id;

/**
 * Inserts a comment under `postId` (a reply to `parentId`, or top level) and keeps the counts:
 * `posts.comment_count` counts every comment of the post, and the parent's `child_count` its
 * direct replies. Deleted and removed comments keep their place and their count, since their
 * replies stay under them. Call it from a rechecked comment.create: the policy has locked the
 * post and the parent FOR NO KEY UPDATE, so these two updates (the post, then the parent, the
 * order of state.ts) cannot wait on another writer in a cycle. The depth is the policy's call;
 * this repeats it as a refusal rather than letting the CHECK constraint fail the transaction.
 */
export async function insertComment(t: WriteTx, subject: { postId: Uuid; parentId: Uuid | null }, row: NewCommentRow): Promise<void> {
  const { postId, parentId } = subject;
  let path = label(row.id);
  if (parentId) {
    const [parent] = await t
      .select({ path: comments.path, depth: sql<number>`nlevel(${comments.path})` })
      .from(comments)
      .where(eq(comments.id, parentId));
    if (!parent) throw new Refused('comment.create', 'target.not_found');
    if (parent.depth >= maxCommentDepth) throw new Refused('comment.create', 'comment.depth_exceeded');
    path = `${parent.path}.${path}`;
  }
  await t
    .update(posts)
    .set({ commentCount: sql`${posts.commentCount} + 1` })
    .where(eq(posts.id, postId));
  if (parentId) {
    await t
      .update(comments)
      .set({ childCount: sql`${comments.childCount} + 1` })
      .where(eq(comments.id, parentId));
  }
  await t.insert(comments).values({ ...row, postId, parentId, path });
}
