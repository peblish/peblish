import { index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { at } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';

// The saves feature's table (branch 5 groundwork; its migration is root's). saves.ts reads and writes it.

/**
 * The posts a person saved, owner-only. One row per owner and post, so saving twice keeps the
 * first. The Saved page walks an owner's rows newest first (saved_posts_owner_saved, keyset on
 * saved_at then post_id); the post reader looks up a page of posts through the primary key.
 * A purged post or actor takes its rows along. Account deletion keeps the actor row, so it
 * deletes these rows itself (identity/personal.ts), as the restore replay does.
 */
export const savedPosts = pgTable(
  'saved_posts',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    savedAt: at('saved_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.postId] }),
    index('saved_posts_owner_saved').on(t.ownerId, t.savedAt.desc(), t.postId.desc()),
    index('saved_posts_post').on(t.postId),
  ],
);
