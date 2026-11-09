import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';

// Lane AZ's tables; root generates their migration. Both record a revocation as an INSERT,
// so their writers first take FOR NO KEY UPDATE on the community's actor row, which every
// policy that reads them locks too (PolicyRequest.lock in authz/policy.ts).

/**
 * Community bans, local and mirrored from a remote community's Block. A ban is in force while
 * expires_at is null or in the future; an expired row grants nothing and a new ban replaces
 * it. An unban deletes the row; the modlog keeps the history.
 */
export const communityBans = pgTable(
  'community_bans',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    expiresAt: at('expires_at'),
    bannedBy: uuid('banned_by').references(() => actors.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.communityId, t.actorId] }), index('community_bans_actor').on(t.actorId)],
);

/**
 * Communities removed by a site admin (or by their own instance, for remote ones): no posts,
 * comments, votes or moderation until the row is deleted again. Deleted communities use
 * actors.deleted_at instead.
 */
export const communityRemovals = pgTable('community_removals', {
  communityId: uuid('community_id')
    .primaryKey()
    .references(() => actors.id, { onDelete: 'cascade' }),
  reason: text('reason'),
  removedBy: uuid('removed_by').references(() => actors.id, { onDelete: 'set null' }),
  removedAt: at('removed_at').notNull().defaultNow(),
});
