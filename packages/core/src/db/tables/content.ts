import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, smallint, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { at, createdAt, id, ltree, raw } from '../columns.ts';
import { actors } from './actors.ts';
import { instances } from './instances.ts';

// Posts, comments and votes carry the identity spine: uuidv7 id, immutable ap_id, local,
// instance_id and raw. Counts are kept in the same transaction as the vote or comment.

const spine = () => ({
  id: id(),
  apId: text('ap_id').notNull().unique(),
  local: boolean('local').notNull(),
  instanceId: uuid('instance_id')
    .notNull()
    .references(() => instances.id),
  raw: raw(),
});

export const posts = pgTable(
  'posts',
  {
    ...spine(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => actors.id),
    communityId: uuid('community_id')
      .notNull()
      .references(() => actors.id),
    title: text('title').notNull(),
    url: text('url'),
    /** Markdown source of a local post. */
    bodyMd: text('body_md'),
    /** Rendered (local) or sanitized (remote) HTML. */
    contentHtml: text('content_html'),
    language: text('language'),
    sensitive: boolean('sensitive').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    featuredCommunity: boolean('featured_community').notNull().default(false),
    featuredLocal: boolean('featured_local').notNull().default(false),
    upvotes: integer('upvotes').notNull().default(0),
    downvotes: integer('downvotes').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    publishedAt: at('published_at').notNull(),
    editedAt: at('edited_at'),
    deletedAt: at('deleted_at'),
    removedAt: at('removed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('posts_community_published').on(t.communityId, t.publishedAt.desc()),
    index('posts_author_published').on(t.authorId, t.publishedAt.desc()),
    index('posts_published').on(t.publishedAt.desc()),
  ],
);

export const comments = pgTable(
  'comments',
  {
    ...spine(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => actors.id),
    parentId: uuid('parent_id').references((): AnyPgColumn => comments.id),
    /** Comment ids from the top-level comment down to this one; at most 50 labels. */
    path: ltree('path').notNull(),
    bodyMd: text('body_md'),
    contentHtml: text('content_html'),
    language: text('language'),
    distinguished: boolean('distinguished').notNull().default(false),
    upvotes: integer('upvotes').notNull().default(0),
    downvotes: integer('downvotes').notNull().default(0),
    childCount: integer('child_count').notNull().default(0),
    publishedAt: at('published_at').notNull(),
    editedAt: at('edited_at'),
    deletedAt: at('deleted_at'),
    removedAt: at('removed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('comments_post').on(t.postId),
    index('comments_path').using('gist', t.path),
    index('comments_author').on(t.authorId),
    check('comments_depth', sql`nlevel(${t.path}) between 1 and 50`),
  ],
);

/**
 * One row per voter and target. Changing direction deletes the row and inserts a new one,
 * because the Like or Dislike activity id (ap_id) is immutable.
 */
export const votes = pgTable(
  'votes',
  {
    ...spine(),
    voterId: uuid('voter_id')
      .notNull()
      .references(() => actors.id),
    postId: uuid('post_id').references(() => posts.id),
    commentId: uuid('comment_id').references(() => comments.id),
    value: smallint('value').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('votes_voter_post').on(t.voterId, t.postId).where(sql`${t.postId} is not null`),
    uniqueIndex('votes_voter_comment').on(t.voterId, t.commentId).where(sql`${t.commentId} is not null`),
    index('votes_post').on(t.postId),
    index('votes_comment').on(t.commentId),
    check('votes_one_target', sql`num_nonnulls(${t.postId}, ${t.commentId}) = 1`),
    check('votes_value', sql`${t.value} in (1, -1)`),
  ],
);
