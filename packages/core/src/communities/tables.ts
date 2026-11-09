import { check, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { actors } from '../db/tables/actors.ts';

// Lane F's table; root generates its migration. A local community's rules are replaced as a
// list by community.update, which holds the community's actor row FOR NO KEY UPDATE, so no
// policy needs to lock these rows.

/**
 * The rules of a local community, in display order: position counts from 1 with no gaps. A
 * rule is a short statement (title) with an optional longer explanation. body_html is
 * rendered from body_md when the rule is saved. Remote communities keep theirs inside `raw`.
 */
export const communityRules = pgTable(
  'community_rules',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md'),
    bodyHtml: text('body_html'),
  },
  (t) => [primaryKey({ columns: [t.communityId, t.position] }), check('community_rules_position', sql`${t.position} >= 1`)],
);
