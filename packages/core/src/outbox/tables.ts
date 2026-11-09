import { bigint, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { at } from '../db/columns.ts';

/**
 * Events a consumer gave up on (worker.ts, processBatch): one that kept failing with an error
 * other than Refused, at least `poisonFailures` times over at least `poisonWindow`, so later
 * events were not held behind it for good. The cursor moved past it and counted it in
 * outbox_cursors.refused; this row keeps what failed, for an operator to look into and replay.
 */
export const outboxSkipped = pgTable(
  'outbox_skipped',
  {
    consumer: text('consumer').notNull(),
    eventId: bigint('event_id', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    /** The last error, as the cursor recorded it. */
    error: text('error'),
    failures: integer('failures').notNull(),
    firstFailureAt: at('first_failure_at').notNull(),
    lastFailureAt: at('last_failure_at').notNull(),
    skippedAt: at('skipped_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.eventId] })],
);
