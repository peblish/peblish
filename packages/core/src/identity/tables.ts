import { bigint, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { at } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';

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

/**
 * The newest TOTP time step (Unix time / 30 s) each user got past two-factor with. A code is
 * accepted only for a later step, so a code seen once (shoulder-surfed, phished) cannot open
 * a second session through a new sign-in (identity/totp-replay.ts).
 */
export const totpSteps = pgTable('totp_steps', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  step: bigint('step', { mode: 'number' }).notNull(),
});

/**
 * Attempts counted per scope and key in a fixed window (identity/throttle.ts). The key is a
 * client address ('ip:203.0.113.7', an IPv6 address by its /64) or a normalised identifier
 * ('id:mira@example.test', a user id).
 */
export const throttles = pgTable(
  'throttles',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    windowStart: at('window_start').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);
