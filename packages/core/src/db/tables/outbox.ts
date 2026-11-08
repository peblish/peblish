import { bigint, index, integer, jsonb, pgTable, smallint, text } from 'drizzle-orm/pg-core';
import { at, createdAt, currentTransactionId, xid8 } from '../columns.ts';

/**
 * The transactional outbox. tx_id is the writing transaction's id: consumers read only rows
 * whose tx_id is below the oldest running transaction (pg_snapshot_xmin), in (tx_id, id)
 * order, so a slow transaction that commits late is never skipped by a cursor.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    txId: xid8('tx_id').notNull().default(currentTransactionId),
    type: text('type').notNull(),
    v: smallint('v').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('outbox_order').on(t.txId, t.id)],
);

/** One cursor per registered consumer: the last (tx_id, id) it has handled. */
export const outboxCursors = pgTable('outbox_cursors', {
  consumer: text('consumer').primaryKey(),
  txId: xid8('tx_id').notNull(),
  eventId: bigint('event_id', { mode: 'number' }).notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  /** Events skipped because a mutation the handler ran refused them (permanent; see ConsumerTx). */
  refused: integer('refused').notNull().default(0),
  retryAt: at('retry_at'),
  updatedAt: at('updated_at').notNull().defaultNow(),
});
