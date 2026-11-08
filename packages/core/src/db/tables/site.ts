import { sql } from 'drizzle-orm';
import { bigint, check, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, enumCheck, id } from '../columns.ts';
import { actors } from './actors.ts';

const subjectKindValues = ['user', 'actor', 'post', 'comment', 'media'] as const;

/** Site settings by key (contract in @peblish/schema/site-settings); written only by lane ADM. */
export const siteSettings = pgTable('site_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => actors.id),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/** Invite codes (stored hashed) with a use cap; invite_uses records the invite chain. */
export const invites = pgTable(
  'invites',
  {
    id: id(),
    codeHash: text('code_hash').notNull().unique(),
    createdBy: uuid('created_by').references(() => actors.id),
    maxUses: integer('max_uses').notNull().default(1),
    useCount: integer('use_count').notNull().default(0),
    note: text('note'),
    expiresAt: at('expires_at'),
    revokedAt: at('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [check('invites_uses', sql`${t.maxUses} > 0 and ${t.useCount} between 0 and ${t.maxUses}`)],
);

export const inviteUses = pgTable(
  'invite_uses',
  {
    inviteId: uuid('invite_id')
      .notNull()
      .references(() => invites.id),
    /** Each actor registers through at most one invite. */
    actorId: uuid('actor_id')
      .notNull()
      .unique()
      .references(() => actors.id),
    usedAt: at('used_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.inviteId, t.actorId] })],
);

/**
 * Append-only record of deletions that must survive a backup restore: after restoring, the
 * ledger is re-applied in id order (B06 drill). Updates and deletes are refused by a trigger.
 */
export const deletionLedger = pgTable(
  'deletion_ledger',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    subjectKind: text('subject_kind', { enum: subjectKindValues }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    subjectApId: text('subject_ap_id'),
    reason: text('reason').notNull(),
    requestedBy: uuid('requested_by'),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [enumCheck('deletion_ledger_subject_kind', t.subjectKind, subjectKindValues)],
);
