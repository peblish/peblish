import { index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { at } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';

// The thread-follow feature's table (branch 5 groundwork; its migration is root's). watches.ts reads and writes it.

/**
 * The threads a person follows, owner-only. One row per owner and post; `since` is when they
 * started, so a fan-out notifies them only of comments received after it. thread_watches_post
 * finds a post's followers for the fan-out; the post reader looks up a page of posts through
 * the primary key. A purged post or actor takes its rows along; account deletion deletes them
 * itself (identity/personal.ts).
 */
export const threadWatches = pgTable(
  'thread_watches',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    since: at('since').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.postId] }), index('thread_watches_post').on(t.postId, t.ownerId)],
);
