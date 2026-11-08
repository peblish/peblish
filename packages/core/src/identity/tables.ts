import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { at } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';

/**
 * The 16+ declaration (decision 2026-11-08): the row is the fact that the person declared it,
 * declared_at is when. Sign-up computes the age from a date of birth it never stores; an
 * account without a row (an imported one, say) has not declared, so NSFW stays hidden.
 */
export const ageDeclarations = pgTable('age_declarations', {
  actorId: uuid('actor_id')
    .primaryKey()
    .references(() => actors.id),
  declaredAt: at('declared_at').notNull().defaultNow(),
});
