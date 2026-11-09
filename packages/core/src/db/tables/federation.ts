import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at, bytea, createdAt, enumCheck, id } from '../columns.ts';

const stateValues = ['pending', 'applied', 'skipped', 'failed'] as const;

/** Every inbound activity as received, stored before processing (lane FED-B leases rows). */
export const inboxRaw = pgTable(
  'inbox_raw',
  {
    id: id(),
    activityId: text('activity_id'),
    activityType: text('activity_type'),
    actorApId: text('actor_ap_id'),
    /** The request body's exact bytes, for signature digests and the byte-for-byte relay (activities.inboxRawId). */
    body: bytea('body').notNull(),
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
    index('inbox_raw_pending')
      .on(t.receivedAt)
      .where(sql`${t.state} = 'pending'`),
    index('inbox_raw_activity').on(t.activityId),
    // Whether any actor of an instance sent something lately (dormancy), and the hourly prune of settled rows.
    index('inbox_raw_actor').on(t.actorApId, t.receivedAt),
    index('inbox_raw_processed')
      .on(t.processedAt)
      .where(sql`${t.state} <> 'pending'`),
  ],
);

/**
 * Ids of activities already applied, written by Tx.dedupe in the same transaction as the
 * change. The id is the applied activity's: the inner activity when it arrives inside an
 * Announce, so a direct copy and an announced copy of the same Create apply once.
 */
export const inboxDedupe = pgTable('inbox_dedupe', {
  activityId: text('activity_id').primaryKey(),
  seenAt: at('seen_at').notNull().defaultNow(),
});

/**
 * Activity documents served at their ids. `raw` is a parsed jsonb copy and does not keep
 * bytes: the byte-for-byte relay (an Announce of the raw JSON) reads the exact bytes from
 * inbox_raw.body through inboxRawId, the row the activity arrived in. Local activities have
 * no inbox row; their JSON is serialized here. A pruned inbox row nulls the link, and the
 * relay then falls back to `raw`.
 */
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
    /** The inbox_raw row a remote activity arrived in: its exact bytes, for the relay. */
    inboxRawId: uuid('inbox_raw_id').references(() => inboxRaw.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('activities_object').on(t.objectApId)],
);
