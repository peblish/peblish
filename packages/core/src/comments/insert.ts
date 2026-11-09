import type { Uuid } from '@peblish/schema/ids';
import { and, eq, sql } from 'drizzle-orm';
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
 * `posts.comment_count` counts every comment of the post, and `child_count` every comment
 * below a comment at any depth, as Lemmy's does (so the parent and each of its ancestors gain
 * one, and a page can say "14 more replies" without counting). Deleted and removed comments
 * keep their place and their count, since their replies stay under them.
 *
 * Call it from a rechecked comment.create. The policy has locked the community, the post and
 * the parent FOR NO KEY UPDATE, in that order, and the ancestors are updated after them (the
 * order of state.ts). They are not locked by the policy, and need not be: every writer that
 * touches a comment holds the community row first, and then the post, so none can reach an
 * ancestor ahead of this transaction. The depth is the policy's call; this repeats it as a
 * refusal rather than letting the CHECK constraint fail the transaction.
 */
export async function insertComment(t: WriteTx, subject: { postId: Uuid; parentId: Uuid | null }, row: NewCommentRow): Promise<void> {
  const { postId, parentId } = subject;
  const parent = parentId ? await parentOf(t, parentId) : null;
  await t
    .update(posts)
    .set({ commentCount: sql`${posts.commentCount} + 1` })
    .where(eq(posts.id, postId));
  if (parent) {
    await t
      .update(comments)
      .set({ childCount: sql`${comments.childCount} + 1` })
      .where(and(eq(comments.postId, postId), sql`${comments.path} @> ${parent.path}::ltree`));
  }
  await t.insert(comments).values({ ...row, postId, parentId, path: parent ? `${parent.path}.${label(row.id)}` : label(row.id) });
}

async function parentOf(t: WriteTx, parentId: Uuid): Promise<{ path: string }> {
  const [parent] = await t
    .select({ path: comments.path, depth: sql<number>`nlevel(${comments.path})` })
    .from(comments)
    .where(eq(comments.id, parentId));
  if (!parent) throw new Refused('comment.create', 'target.not_found');
  if (parent.depth >= maxCommentDepth) throw new Refused('comment.create', 'comment.depth_exceeded');
  return parent;
}
