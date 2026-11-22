import { index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { at } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';

// The "new since last visit" feature's table (branch 5 groundwork; its migration is root's). visits.ts reads and writes it.

/**
 * A person's visit marker on a thread, owner-only: one row per owner and post, written when
 * they open it. No row means no visit yet, and the first visit only sets the baseline.
 * `last_visit_at` is the latest visit; `previous_visit_at` is the boundary the current visit
 * compares against (null until there was a visit before), so the markers stay put while the
 * person re-sorts or pages the thread and a later visit rotates the two. What counts as new is
 * one definition, in visits.ts, over comments.created_at (the time this server received a
 * comment). A purged post or actor takes its rows along; account deletion deletes them itself
 * (identity/personal.ts).
 */
export const threadVisits = pgTable(
  'thread_visits',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    lastVisitAt: at('last_visit_at').notNull(),
    previousVisitAt: at('previous_visit_at'),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.postId] }), index('thread_visits_post').on(t.postId)],
);
