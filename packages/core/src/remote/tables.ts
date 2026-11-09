import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at, enumCheck } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';
import { instances } from '../db/tables/instances.ts';

// Owned by lane REM. What the instance remembers about peers beyond their documents: which are
// dormant, and which followed communities still owe a backfill.

const healthValues = ['active', 'dormant'] as const;

/**
 * One row for each instance that has ever gone dormant (an instance with no row is active).
 * Delivery skips a dormant instance except for one probe a day (remote/dormant.ts). `state`
 * only leaves dormant on evidence the instance is alive (a delivered probe, an inbound
 * activity), never because the failed deliveries that proved it were pruned.
 */
export const instanceHealth = pgTable(
  'instance_health',
  {
    instanceId: uuid('instance_id')
      .primaryKey()
      .references(() => instances.id, { onDelete: 'cascade' }),
    state: text('state', { enum: healthValues }).notNull().default('active'),
    /** When the unbroken run of failed deliveries that made it dormant began. */
    failingSince: at('failing_since'),
    dormantSince: at('dormant_since'),
    revivedAt: at('revived_at'),
    /** The last time a delivery was let through while dormant (or the moment it went dormant). */
    lastProbeAt: at('last_probe_at'),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [enumCheck('instance_health_state', t.state, healthValues)],
);

const backfillValues = ['pending', 'running', 'done', 'failed'] as const;

/**
 * The backfill of a followed remote community (federation/src/backfill): queued when our
 * follow is accepted, claimed by a job under a lease, settled when its caps or its collections
 * run out. One row per community; following again queues it again.
 */
export const backfills = pgTable(
  'backfills',
  {
    communityId: uuid('community_id')
      .primaryKey()
      .references(() => actors.id, { onDelete: 'cascade' }),
    state: text('state', { enum: backfillValues }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: at('next_attempt_at').notNull().defaultNow(),
    /** While in the future, a worker owns the row. */
    leaseUntil: at('lease_until'),
    queuedAt: at('queued_at').notNull().defaultNow(),
    finishedAt: at('finished_at'),
    /** Posts and comments this backfill stored (a repeat run stores none it already holds). */
    posts: integer('posts').notNull().default(0),
    comments: integer('comments').notNull().default(0),
    /** Why it ended early or failed, or a note on a cut short run. */
    note: text('note'),
  },
  (t) => [
    enumCheck('backfills_state', t.state, backfillValues),
    index('backfills_due')
      .on(t.nextAttemptAt)
      .where(sql`${t.state} in ('pending', 'running')`),
  ],
);

/**
 * When a held remote post or comment was last asked after at its own server
 * (federation/src/remote-fetch/recheck.ts), so a 410 or a Tombstone for it is found a day
 * after it happens at most and each object is asked about once a day. A row exists only for an
 * object that has been rechecked; one with no row counts as checked when we stored it. The id is a
 * posts.id or a comments.id (no foreign key: it names one of two tables).
 */
export const objectRechecks = pgTable(
  'object_rechecks',
  {
    objectId: uuid('object_id').primaryKey(),
    checkedAt: at('checked_at').notNull(),
  },
  (t) => [index('object_rechecks_checked').on(t.checkedAt)],
);
