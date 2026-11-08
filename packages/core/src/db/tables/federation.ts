import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { at, createdAt, enumCheck, id } from '../columns.ts';

const stateValues = ['pending', 'applied', 'skipped', 'failed'] as const;

/** Every inbound activity as received, stored before processing (lane FED-B leases rows). */
export const inboxRaw = pgTable(
  'inbox_raw',
  {
    id: id(),
    activityId: text('activity_id'),
    activityType: text('activity_type'),
    actorApId: text('actor_ap_id'),
    body: jsonb('body').notNull(),
    /** The request headers signature verification needs. */
    headers: jsonb('headers'),
    state: text('state', { enum: stateValues }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    leaseUntil: at('lease_until'),
    error: text('error'),
    processedAt: at('processed_at'),
    receivedAt: at('received_at').notNull().defaultNow(),
  },
  (t) => [
    enumCheck('inbox_raw_state', t.state, stateValues),
    index('inbox_raw_pending').on(t.receivedAt).where(sql`${t.state} = 'pending'`), index('inbox_raw_activity').on(t.activityId)],
);

/** Activity ids already applied; written by Tx.dedupe in the same transaction as the change. */
export const inboxDedupe = pgTable('inbox_dedupe', {
  activityId: text('activity_id').primaryKey(),
  seenAt: at('seen_at').notNull().defaultNow(),
});

/** Activity documents served at their ids and relayed byte-for-byte (Announce of raw JSON). */
export const activities = pgTable(
  'activities',
  {
    id: id(),
    apId: text('ap_id').notNull().unique(),
    type: text('type').notNull(),
    actorApId: text('actor_ap_id').notNull(),
    objectApId: text('object_ap_id'),
    local: boolean('local').notNull(),
    raw: jsonb('raw').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('activities_object').on(t.objectApId)],
);
