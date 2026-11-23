import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { actors } from '../db/tables/actors.ts';

// The pins feature's table (branch 5 groundwork; its migration is root's). pins.ts reads and writes it.

/**
 * The communities a person pinned in their sidebar, in their order, owner-only. One row per
 * owner and community. `position` counts from 0, and the writes keep an owner's positions
 * dense (0 to n - 1) under a lock of the owner's own. It is deliberately not unique: Postgres
 * checks a plain unique index row by row, so shifting a run of pins in one UPDATE would trip
 * it. A pin does not reference the follow: the reader shows only pins of communities the owner
 * still follows and may see, and a pin outlives an unfollow so a re-follow finds its place.
 * A purged actor takes its rows along; account deletion deletes them itself (identity/personal.ts).
 */
export const communityPins = pgTable(
  'community_pins',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    communityId: uuid('community_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.communityId] }),
    index('community_pins_owner_position').on(t.ownerId, t.position),
    index('community_pins_community').on(t.communityId),
    check('community_pins_position', sql`${t.position} >= 0`),
  ],
);
