import { and, eq, sql } from 'drizzle-orm';
import { parseEvent, type OutboxEvent } from '@peblish/schema/events';
import { consumers as registered } from '../registry/consumers.gen.ts';
import { db } from '../db/read.ts';
import { outbox, outboxCursors } from '../db/tables/outbox.ts';
import { writePool } from '../db/pools.ts';
import { writer } from '../db/write.ts';
import { Refused } from '../tx/refused.ts';
import { insideTransaction, OUTBOX_CHANNEL, outboxEmitter } from '../tx/tx.ts';
import { assertRunnable, type Consumer } from './consumers.ts';
import { outboxSkipped } from './tables.ts';

/**
 * A poison event: one that has failed (with anything but Refused) at least this many times, over
 * at least `poisonWindow`, is skipped so the events behind it can go on (processBatch).
 */
export const poisonFailures = 10;
export const poisonWindow = sql`interval '30 minutes'`;

/**
 * Creates missing cursor rows, each at its consumer's startAt (see ConsumerStart), after
 * assertRunnable (unique names, no consumer feeding itself). Existing cursors are kept.
 */
export async function ensureCursors(consumers: readonly Consumer[]): Promise<void> {
  assertRunnable(consumers);
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
 *
 * A failure in a handler also records that event on the cursor row: its id, how many times in a
 * row it failed and when it first did. Once the same event has failed `poisonFailures` times
 * over at least `poisonWindow`, the next batch skips it: it is logged, written to
 * outbox_skipped, counted in `refused`, and the cursor moves past it. Recording a failure is a
 * write, so an outage of the database itself never reaches the threshold: when the write fails,
 * nothing is counted.
 * Returns how many rows the cursor moved past, matching or not.
 */
export async function processBatch(consumer: Consumer, limit = 100): Promise<number> {
  // The event whose handler is running, so a failure can be pinned on it.
  let failing: number | undefined;
  try {
    return await writer().transaction(async (db) =>
      insideTransaction(async () => {
        const [cursor] = await db
          .select({
            txId: outboxCursors.txId,
            eventId: outboxCursors.eventId,
            failingEventId: outboxCursors.failingEventId,
            failures: outboxCursors.failures,
            firstFailureAt: outboxCursors.firstFailureAt,
            // Only failures write the cursor while an event keeps failing, so its last write is the last failure.
            lastFailureAt: outboxCursors.updatedAt,
            lastError: outboxCursors.lastError,
            poisoned: sql<boolean>`${outboxCursors.failures} >= ${poisonFailures} and ${outboxCursors.firstFailureAt} <= now() - ${poisonWindow}`,
          })
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
        const emit = async (event: OutboxEvent) => {
          if (!consumer.emits.includes(event.type)) throw new TypeError(`outbox consumer ${consumer.name} may not emit ${event.type}`);
          await events.emit(event);
        };
        let refused = 0;
        // The rows this batch moves past: all of them, or up to a skipped poison event, so the skip
        // commits on its own and a later event failing in the same batch cannot roll it back.
        let scanned = rows.length;
        for (const [index, row] of rows.entries()) {
          if (!consumer.events.some((type) => type === row.type)) continue;
          if (cursor.poisoned && cursor.failingEventId === row.id && cursor.firstFailureAt) {
            refused += 1;
            console.error(
              `outbox consumer ${consumer.name} skipped outbox event ${row.id} (${row.type}) after ${cursor.failures} failures: ${cursor.lastError ?? 'no error recorded'}`,
            );
            await db
              .insert(outboxSkipped)
              .values({
                consumer: consumer.name,
                eventId: row.id,
                type: row.type,
                error: cursor.lastError,
                failures: cursor.failures,
                firstFailureAt: cursor.firstFailureAt,
                lastFailureAt: cursor.lastFailureAt,
              })
              .onConflictDoNothing();
            scanned = index + 1;
            break;
          }
          failing = row.id;
          const event = parseEvent(row.payload);
          try {
            // A savepoint per event, so a refused event leaves none of its handler's writes.
            await db.transaction((savepoint) => consumer.handle(event, { db: savepoint, emit }));
          } catch (error) {
            if (!(error instanceof Refused)) throw error;
            refused += 1;
            console.error(
              `outbox consumer ${consumer.name} skipped outbox event ${row.id} (${row.type}): ${error.action} refused with ${error.reason}`,
            );
          }
          failing = undefined;
        }
        const last = rows[scanned - 1];
        if (last) {
          await db
            .update(outboxCursors)
            .set({
              txId: last.txId,
              eventId: last.id,
              attempts: 0,
              lastError: null,
              retryAt: null,
              failingEventId: null,
              failures: 0,
              firstFailureAt: null,
              refused: sql`${outboxCursors.refused} + ${refused}`,
              updatedAt: new Date(),
            })
            .where(eq(outboxCursors.consumer, consumer.name));
        }
        await events.notify();
        return scanned;
      }),
    );
  } catch (error) {
    await recordFailure(consumer, error, failing).catch(() => {
      // The consumer's error is the one worth reporting; the next attempt records again.
    });
    throw error;
  }
}

/**
 * Counts the failure and sets the next retry: 2^attempts seconds, the exponent capped before it
 * can overflow. A failure in a handler (`eventId`) counts against that event: one more for the
 * event already failing, else a new count from 1. A failure outside any handler leaves the
 * event's count as it was.
 */
function recordFailure(consumer: Consumer, error: unknown, eventId: number | undefined) {
  const same = sql`${outboxCursors.failingEventId} is not distinct from ${eventId ?? null}::bigint`;
  return writer()
    .update(outboxCursors)
    .set({
      ...(eventId !== undefined && {
        failingEventId: eventId,
        failures: sql`case when ${same} then ${outboxCursors.failures} + 1 else 1 end`,
        firstFailureAt: sql`case when ${same} then ${outboxCursors.firstFailureAt} else now() end`,
      }),
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
  /** Called once the cursors exist and the NOTIFY listener is up: the worker is ready. */
  onReady?: () => void;
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
  onReady,
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
  onReady?.();
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
      if (signal.aborted) break;
      // Sleeps until the poll timer, a NOTIFY or an abort, whichever comes first.
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
