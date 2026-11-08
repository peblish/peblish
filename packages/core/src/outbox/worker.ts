import { and, eq, sql } from 'drizzle-orm';
import { parseEvent } from '@peblish/schema/events';
import { consumers as registered } from '../registry/consumers.gen.ts';
import { db } from '../db/read.ts';
import { outbox, outboxCursors } from '../db/tables/outbox.ts';
import { writePool } from '../db/pools.ts';
import { writer } from '../db/write.ts';
import { insideTransaction, OUTBOX_CHANNEL, outboxEmitter } from '../tx/tx.ts';
import { assertUniqueNames, type Consumer } from './consumers.ts';

/**
 * Creates missing cursor rows, each at its consumer's startAt (see ConsumerStart), and
 * rejects duplicate names. Existing cursors are kept.
 */
export async function ensureCursors(consumers: readonly Consumer[]): Promise<void> {
  assertUniqueNames(consumers);
  if (consumers.length === 0) return;
  await writer()
    .insert(outboxCursors)
    .values(
      consumers.map(({ name, startAt }) => ({
        consumer: name,
        txId: startAt === 'beginning' ? sql`'0'::xid8` : sql`pg_snapshot_xmin(pg_current_snapshot())`,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Scans the next `limit` outbox rows after `consumer`'s cursor, hands it the ones of its event
 * types and advances the cursor to the last row scanned, all in one transaction. Only rows
 * below the oldest running transaction id are read, so an earlier transaction that commits
 * later is never skipped. The cursor row is locked (skip locked), so concurrent workers never
 * run one consumer twice. On failure the batch rolls back, the cursor stays and the consumer
 * backs off (doubling, capped at five minutes); later events wait behind the failing one.
 * Returns how many rows the cursor moved past, matching or not.
 */
export async function processBatch(consumer: Consumer, limit = 100): Promise<number> {
  try {
    return await writer().transaction(async (db) =>
      insideTransaction(async () => {
        const [cursor] = await db
          .select({ txId: outboxCursors.txId, eventId: outboxCursors.eventId })
          .from(outboxCursors)
          .where(
            and(eq(outboxCursors.consumer, consumer.name), sql`(${outboxCursors.retryAt} is null or ${outboxCursors.retryAt} <= now())`),
          )
          .for('update', { skipLocked: true });
        if (!cursor) return 0;
        const rows = await db
          .select({ id: outbox.id, txId: outbox.txId, type: outbox.type, payload: outbox.payload })
          .from(outbox)
          .where(
            and(
              sql`(${outbox.txId}, ${outbox.id}) > (${cursor.txId}::xid8, ${cursor.eventId})`,
              sql`${outbox.txId} < pg_snapshot_xmin(pg_current_snapshot())`,
            ),
          )
          .orderBy(outbox.txId, outbox.id)
          .limit(limit);
        const events = outboxEmitter(db);
        const t = { db, emit: events.emit };
        for (const row of rows) {
          if (consumer.events.some((type) => type === row.type)) await consumer.handle(parseEvent(row.payload), t);
        }
        const last = rows.at(-1);
        if (last) {
          await db
            .update(outboxCursors)
            .set({ txId: last.txId, eventId: last.id, attempts: 0, lastError: null, retryAt: null, updatedAt: new Date() })
            .where(eq(outboxCursors.consumer, consumer.name));
        }
        await events.notify();
        return rows.length;
      }),
    );
  } catch (error) {
    await recordFailure(consumer, error).catch(() => {
      // The consumer's error is the one worth reporting; the next attempt records again.
    });
    throw error;
  }
}

/** Counts the failure and sets the next retry: 2^attempts seconds, the exponent capped before it can overflow. */
function recordFailure(consumer: Consumer, error: unknown) {
  return writer()
    .update(outboxCursors)
    .set({
      attempts: sql`${outboxCursors.attempts} + 1`,
      lastError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      retryAt: sql`now() + least(interval '1 second' * power(2, least(${outboxCursors.attempts}, 9)), interval '5 minutes')`,
      updatedAt: new Date(),
    })
    .where(eq(outboxCursors.consumer, consumer.name));
}

export type OldestTransaction = { pid: number; database: string | null; application: string; state: string | null; ageSeconds: number };

/**
 * The oldest open transaction on the cluster that holds a transaction id, and so holds back
 * the outbox horizon for every consumer, in every database on that Postgres (a stuck psql
 * session in one lane's database stalls every lane). `database` narrows the search, for
 * tests on a shared cluster. Undefined when there is none.
 */
export async function oldestWriteTransaction(database?: string): Promise<OldestTransaction | undefined> {
  const [oldest] = await db().execute<OldestTransaction>(sql`
    select pid, datname as database, application_name as application, state,
           extract(epoch from now() - xact_start)::float8 as "ageSeconds"
    from pg_stat_activity
    where backend_xid is not null and pid <> pg_backend_pid() and (${database ?? null}::text is null or datname = ${database ?? null})
    order by xact_start
    limit 1`);
  return oldest;
}

export type WorkerOptions = {
  signal: AbortSignal;
  consumers?: readonly Consumer[];
  batchSize?: number;
  /** Fallback poll interval; NOTIFY on commit wakes the worker sooner. */
  pollMs?: number;
  onError?: (consumer: Consumer, error: unknown) => void;
  /** Warn when the oldest write transaction (the horizon) is older than this. */
  lagWarningSeconds?: number;
  onLag?: (oldest: OldestTransaction) => void;
};

const describeLag = ({ ageSeconds, pid, database, application, state }: OldestTransaction) =>
  `outbox: consumers are waiting behind a write transaction open for ${Math.round(ageSeconds)} s ` +
  `(pid ${pid}, database ${database ?? '?'}, application ${application || '?'}, state ${state ?? '?'})`;

/** Runs `consumers` (default: core's registered ones) until `signal` aborts. Throws on duplicate names. */
export async function runOutboxWorker({
  signal,
  consumers = registered,
  batchSize = 100,
  pollMs = 1_000,
  onError = (consumer, error) => console.error(`outbox consumer ${consumer.name} failed`, error),
  lagWarningSeconds = 30,
  onLag = (oldest) => console.warn(describeLag(oldest)),
}: WorkerOptions): Promise<void> {
  await ensureCursors(consumers);
  const lagCheckMs = Math.max(lagWarningSeconds, 5) * 1_000;
  let lagCheckedAt = 0;
  // A NOTIFY that lands while a batch runs sets `woken`, so the loop goes round again
  // instead of sleeping on an event it has not read.
  let woken = false;
  let wake: (() => void) | undefined;
  const listener = await writePool().client.listen(OUTBOX_CHANNEL, () => {
    woken = true;
    wake?.();
  });
  try {
    while (!signal.aborted) {
      woken = false;
      if (Date.now() - lagCheckedAt >= lagCheckMs) {
        lagCheckedAt = Date.now();
        const oldest = await oldestWriteTransaction().catch(() => undefined);
        if (oldest && oldest.ageSeconds > lagWarningSeconds) onLag(oldest);
      }
      let scanned = 0;
      for (const consumer of consumers) {
        try {
          scanned += await processBatch(consumer, batchSize);
        } catch (error) {
          onError(consumer, error);
        }
      }
      if (scanned > 0 || woken) continue;
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
