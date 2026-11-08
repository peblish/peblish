import { and, eq, inArray, sql } from 'drizzle-orm';
import { parseEvent } from '@peblish/schema/events';
import { consumers as registered } from '../registry/consumers.gen.ts';
import { outbox, outboxCursors } from '../db/tables/outbox.ts';
import { writePool } from '../db/pools.ts';
import { writer } from '../db/write.ts';
import { OUTBOX_CHANNEL } from '../tx/tx.ts';
import type { Consumer } from './consumers.ts';

/**
 * Creates missing cursor rows. A consumer seen for the first time starts at "now": it gets
 * every event from transactions still running or started later, none from before.
 */
export async function ensureCursors(consumers: readonly Consumer[]): Promise<void> {
  if (consumers.length === 0) return;
  await writer()
    .insert(outboxCursors)
    .values(consumers.map(({ name }) => ({ consumer: name, txId: sql`pg_snapshot_xmin(pg_current_snapshot())` })))
    .onConflictDoNothing();
}

/**
 * Hands the next batch of events to `consumer` and advances its cursor, all in one
 * transaction. Only rows below the oldest running transaction id are read, so an earlier
 * transaction that commits later is never skipped. The cursor row is locked (skip locked),
 * so concurrent workers never run one consumer twice. On failure the batch rolls back and the
 * consumer backs off (capped at five minutes); later events wait behind the failing one.
 * Returns the number of events handled.
 */
export async function processBatch(consumer: Consumer, limit = 100): Promise<number> {
  try {
    return await writer().transaction(async (db) => {
      const [cursor] = await db
        .select({ txId: outboxCursors.txId, eventId: outboxCursors.eventId })
        .from(outboxCursors)
        .where(and(eq(outboxCursors.consumer, consumer.name), sql`(${outboxCursors.retryAt} is null or ${outboxCursors.retryAt} <= now())`))
        .for('update', { skipLocked: true });
      if (!cursor) return 0;
      const rows = await db
        .select({ id: outbox.id, txId: outbox.txId, payload: outbox.payload })
        .from(outbox)
        .where(
          and(
            sql`(${outbox.txId}, ${outbox.id}) > (${cursor.txId}::xid8, ${cursor.eventId})`,
            sql`${outbox.txId} < pg_snapshot_xmin(pg_current_snapshot())`,
            inArray(outbox.type, [...consumer.events]),
          ),
        )
        .orderBy(outbox.txId, outbox.id)
        .limit(limit);
      for (const row of rows) await consumer.handle(parseEvent(row.payload), { db });
      const last = rows.at(-1);
      if (last) {
        await db
          .update(outboxCursors)
          .set({ txId: last.txId, eventId: last.id, attempts: 0, lastError: null, retryAt: null, updatedAt: new Date() })
          .where(eq(outboxCursors.consumer, consumer.name));
      }
      return rows.length;
    });
  } catch (error) {
    await writer()
      .update(outboxCursors)
      .set({
        attempts: sql`${outboxCursors.attempts} + 1`,
        lastError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        retryAt: sql`now() + least(interval '1 second' * power(2, ${outboxCursors.attempts}), interval '5 minutes')`,
        updatedAt: new Date(),
      })
      .where(eq(outboxCursors.consumer, consumer.name));
    throw error;
  }
}

export type WorkerOptions = {
  signal: AbortSignal;
  consumers?: readonly Consumer[];
  batchSize?: number;
  /** Fallback poll interval; NOTIFY on commit wakes the worker sooner. */
  pollMs?: number;
  onError?: (consumer: Consumer, error: unknown) => void;
};

/** Runs the registered consumers until `signal` aborts. */
export async function runOutboxWorker({
  signal,
  consumers = registered,
  batchSize = 100,
  pollMs = 1_000,
  onError = (consumer, error) => console.error(`outbox consumer ${consumer.name} failed`, error),
}: WorkerOptions): Promise<void> {
  await ensureCursors(consumers);
  let wake: (() => void) | undefined;
  const listener = await writePool().client.listen(OUTBOX_CHANNEL, () => wake?.());
  try {
    while (!signal.aborted) {
      let handled = 0;
      for (const consumer of consumers) {
        try {
          handled += await processBatch(consumer, batchSize);
        } catch (error) {
          onError(consumer, error);
        }
      }
      if (handled > 0) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, pollMs);
        signal.addEventListener('abort', done, { once: true });
        wake = done;
        function done() {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          wake = undefined;
          resolve();
        }
      });
    }
  } finally {
    await listener.unlisten();
  }
}
