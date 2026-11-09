import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, enumCheck, id } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';
import { instances } from '../db/tables/instances.ts';

// Owned by lane FED-A. The durable outbound delivery queue (federation/src/delivery).

const stateValues = ['pending', 'delivered', 'failed', 'skipped'] as const;

/**
 * One row per (activity, inbox): a signed POST waiting to be made. The body is the activity's
 * exact JSON text, fixed when the row is written, so every retry sends the same bytes (only
 * the Date and Signature headers are new). A worker claims due rows with FOR UPDATE SKIP LOCKED
 * and a lease, and a worker that dies mid-POST leaves a lease that expires, so the row is
 * sent again: delivery is at least once, and receivers dedupe on the activity id. A row ends
 * `delivered` (2xx), `failed` (a permanent refusal, or the retries ran out) or `skipped` (the
 * instance is dormant). Nothing prunes old rows yet.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: id(),
    /** The activity's id, as served at its ap_id. */
    activityApId: text('activity_ap_id').notNull(),
    activityType: text('activity_type').notNull(),
    /** What the activity is about (the post, comment or actor it names), for lookups. */
    objectApId: text('object_ap_id'),
    /** The local actor whose key signs the request: the author, or the community for an Announce. */
    senderId: uuid('sender_id')
      .notNull()
      .references(() => actors.id),
    inboxUrl: text('inbox_url').notNull(),
    /** The receiving instance, when it is known: dormancy is judged per instance. */
    instanceId: uuid('instance_id').references(() => instances.id),
    body: text('body').notNull(),
    state: text('state', { enum: stateValues }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: at('next_attempt_at').notNull().defaultNow(),
    /** While in the future, a worker owns the row. */
    leaseUntil: at('lease_until'),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    /** When the row reached delivered, failed or skipped. */
    settledAt: at('settled_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('deliveries_activity_inbox').on(t.activityApId, t.inboxUrl),
    enumCheck('deliveries_state', t.state, stateValues),
    index('deliveries_due')
      .on(t.nextAttemptAt)
      .where(sql`${t.state} = 'pending'`),
    index('deliveries_object').on(t.objectApId),
    index('deliveries_instance').on(t.instanceId, t.state),
  ],
);
