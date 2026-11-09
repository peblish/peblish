import { boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, enumCheck } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';

// Lane MODF's table; root generates its migration. A site ban is recorded as an INSERT, so its
// writer first takes FOR NO KEY UPDATE on the target actor row, which the principal refresh
// (authz/principal.ts) and the site ban policies lock too (PolicyRequest.lock in authz/policy.ts).

const sourceValues = ['local', 'remote'] as const;

/**
 * Site bans, set here (source 'local') or by the person's own instance (source 'remote', a
 * Block aimed at the instance). A ban is in force while expires_at is null or ahead; an
 * expired row grants nothing and a new ban replaces it. An unban deletes the row; the modlog
 * keeps the history.
 */
export const siteBans = pgTable(
  'site_bans',
  {
    actorId: uuid('actor_id')
      .primaryKey()
      .references(() => actors.id, { onDelete: 'cascade' }),
    source: text('source', { enum: sourceValues }).notNull(),
    reason: text('reason'),
    expiresAt: at('expires_at'),
    bannedBy: uuid('banned_by').references(() => actors.id, { onDelete: 'set null' }),
    /** The federated Block that carried a remote ban. */
    activityApId: text('activity_ap_id'),
    /** Whether the actor's content was removed with the ban. */
    removeContent: boolean('remove_content').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [enumCheck('site_bans_source', t.source, sourceValues)],
);
