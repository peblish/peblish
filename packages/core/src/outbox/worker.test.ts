import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { EventType, OutboxEvent } from '@peblish/schema/events';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { inboxDedupe } from '../db/tables/federation.ts';
import { outbox, outboxCursors } from '../db/tables/outbox.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { tx } from '../tx/tx.ts';
import { defineConsumer, type Consumer, type ConsumerStart, type ConsumerTx } from './consumers.ts';
import { ensureCursors, oldestWriteTransaction, processBatch, runOutboxWorker, type OldestTransaction } from './worker.ts';

// The outbox horizon is cluster-wide, so another lane's open transaction can hold back what a
// batch may read. Counts that depend on it are polled (drain); assertions that a batch reads
// nothing are made only while this test itself holds the horizon back.

const uuid = (n: number) => `0192f5a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const post = (n: number): OutboxEvent => ({
  type: 'post.created',
  v: 1,
  postId: uuid(n),
  communityId: uuid(0),
  authorId: uuid(0),
  local: true,
});
const comment = (n: number): OutboxEvent => ({
  type: 'comment.created',
  v: 1,
  commentId: uuid(n),
  postId: uuid(0),
  authorId: uuid(0),
  parentId: null,
  local: true,
});
const idOf = (event: OutboxEvent) => ('commentId' in event ? event.commentId : 'postId' in event ? event.postId : event.type);

function recorder(
  options: {
    name?: string;
    events?: [EventType, ...EventType[]];
    startAt?: ConsumerStart;
    handle?: (event: OutboxEvent, t: ConsumerTx) => Promise<void>;
  } = {},
) {
  const seen: string[] = [];
  const consumer = defineConsumer({
    name: options.name ?? 'test.recorder',
    events: options.events ?? ['post.created'],
    startAt: options.startAt ?? 'beginning',
    async handle(event, t) {
      await options.handle?.(event, t);
      seen.push(idOf(event));
    },
  });
  return { seen, consumer };
}

const emit = (...events: OutboxEvent[]) =>
  tx(async (t) => {
    for (const event of events) await t.emit(event);
  });

/** A gate a test opens by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** Opens a transaction that emits and then waits for `commit()` before committing. */
function heldOpen(event: OutboxEvent) {
  const started = gate();
  const release = gate();
  const done = tx(async (t) => {
    await t.emit(event);
    started.open();
    await release.opened;
  });
  return {
    started: started.opened,
    commit: async () => {
      release.open();
      await done;
    },
  };
}

/** Runs batches until `seen` matches: the horizon may hold some rows back for a moment. */
const drain = (consumer: Consumer, seen: string[], expected: string[], limit?: number) =>
  expect
    .poll(async () => {
      await processBatch(consumer, limit);
      return seen;
    })
    .toEqual(expected);

const cursorOf = async (consumer: Consumer) =>
  (await db().select().from(outboxCursors).where(eq(outboxCursors.consumer, consumer.name)))[0];

/** True once no running transaction anywhere is older than the newest outbox row. */
const horizonPassedOutbox = async () =>
  (
    await db().execute<{ passed: boolean }>(
      sql`select pg_snapshot_xmin(pg_current_snapshot()) > (select max(tx_id) from ${outbox}) as passed`,
    )
  )[0]?.passed;

beforeEach(truncateAll);

describe('consumer start', () => {
  test("'beginning' gets every event still in the outbox", async () => {
    await emit(post(1));
    const { seen, consumer } = recorder({ startAt: 'beginning' });
    await ensureCursors([consumer]);
    await emit(post(2));
    await drain(consumer, seen, [uuid(1), uuid(2)]);
  });

  test("'now' skips events committed before the horizon", async () => {
    await emit(post(1));
    await expect.poll(horizonPassedOutbox).toBe(true);
    const { seen, consumer } = recorder({ startAt: 'now' });
    await ensureCursors([consumer]);
    await emit(post(2));
    await drain(consumer, seen, [uuid(2)]);
  });

  test("'now' starts at the safe horizon: an older open transaction and a newer committed event are both delivered", async () => {
    const slow = heldOpen(post(1));
    await slow.started;
    await emit(post(2));
    const { seen, consumer } = recorder({ startAt: 'now' });
    await ensureCursors([consumer]);
    expect(await processBatch(consumer)).toBe(0);
    await slow.commit();
    await drain(consumer, seen, [uuid(1), uuid(2)]);
  });

  test('two consumers with one name are rejected', async () => {
    const consumers = [recorder().consumer, recorder().consumer];
    await expect(ensureCursors(consumers)).rejects.toThrow('two outbox consumers are named test.recorder');
    const controller = new AbortController();
    await expect(runOutboxWorker({ signal: controller.signal, consumers })).rejects.toThrow(/named test\.recorder/);
    expect(await db().select().from(outboxCursors)).toEqual([]);
  });
});

describe('outbox worker', () => {
  test('events arrive in commit-safe order, once', async () => {
    const { seen, consumer } = recorder();
    await ensureCursors([consumer]);
    await emit(post(1), post(2));
    await emit(post(3));
    await drain(consumer, seen, [uuid(1), uuid(2), uuid(3)]);
    expect(await processBatch(consumer)).toBe(0);
  });

  test('an earlier transaction that commits later is not skipped', async () => {
    const { seen, consumer } = recorder();
    await ensureCursors([consumer]);
    const slow = heldOpen(post(1));
    await slow.started;
    await emit(post(2));
    // The slow transaction holds back the snapshot horizon, so nothing is read past it yet.
    expect(await processBatch(consumer)).toBe(0);
    await slow.commit();
    await drain(consumer, seen, [uuid(1), uuid(2)]);
  });

  test('a rolled-back transaction never reaches a consumer', async () => {
    const { seen, consumer } = recorder();
    await ensureCursors([consumer]);
    await expect(
      tx(async (t) => {
        await t.emit(post(1));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await emit(post(2));
    await drain(consumer, seen, [uuid(2)]);
  });

  test('limit 2 over two transactions of three events: each event once, in order, across calls', async () => {
    const { seen, consumer } = recorder();
    await ensureCursors([consumer]);
    await emit(post(1), post(2), post(3));
    await emit(post(4), post(5), post(6));
    const counts: number[] = [];
    await expect
      .poll(async () => {
        counts.push(await processBatch(consumer, 2));
        return seen;
      })
      .toEqual([1, 2, 3, 4, 5, 6].map(uuid));
    expect(counts.every((count) => count <= 2)).toBe(true);
    expect(await processBatch(consumer, 2)).toBe(0);
  });

  test('the type filter skips other events, and the cursor moves past them', async () => {
    const { seen, consumer } = recorder({ events: ['comment.created'] });
    await ensureCursors([consumer]);
    await emit(post(1), comment(2), post(3));
    await emit(post(4), post(5));
    await drain(consumer, seen, [uuid(2)]);
    // A rare-type consumer does not rescan the tail: its cursor sits on the last row scanned.
    await expect.poll(async () => (await cursorOf(consumer))?.eventId).toBe(5);
    expect(await processBatch(consumer)).toBe(0);
  });

  test('a second worker gets nothing while the first holds the batch', async () => {
    const inHandler = gate();
    const release = gate();
    const { seen, consumer } = recorder({
      async handle() {
        inHandler.open();
        await release.opened;
      },
    });
    await ensureCursors([consumer]);
    await emit(post(1));
    const first = (async () => {
      // Retry until the horizon lets the first batch see the event.
      while ((await processBatch(consumer)) === 0 && seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    })();
    await inHandler.opened;
    expect(await processBatch(consumer)).toBe(0);
    release.open();
    await first;
    expect(seen).toEqual([uuid(1)]);
    expect(await processBatch(consumer)).toBe(0);
  });

  test('a failing consumer leaves another consumer untouched', async () => {
    const failing = recorder({
      name: 'test.failing',
      async handle() {
        throw new Error('refused');
      },
    });
    const healthy = recorder({ name: 'test.healthy' });
    await ensureCursors([failing.consumer, healthy.consumer]);
    await emit(post(1), post(2));
    await drain(healthy.consumer, healthy.seen, [uuid(1), uuid(2)]);
    await expect(processBatch(failing.consumer)).rejects.toThrow('refused');
    expect(await cursorOf(failing.consumer)).toMatchObject({ eventId: 0, attempts: 1 });
    expect(await cursorOf(healthy.consumer)).toMatchObject({ eventId: 2, attempts: 0, lastError: null });
  });

  test('a failing handler rolls back its batch, writes included, and backs off without moving the cursor', async () => {
    let failing = true;
    const { seen, consumer } = recorder({
      async handle(event, t) {
        await t.db.insert(inboxDedupe).values({ activityId: `consumed:${idOf(event)}` });
        if (failing && idOf(event) === uuid(2)) throw new Error(`refused ${uuid(2)}`);
      },
    });
    await ensureCursors([consumer]);
    await emit(post(1), post(2));
    await expect.poll(horizonPassedOutbox).toBe(true);
    await expect(processBatch(consumer)).rejects.toThrow(/refused/);
    expect(await db().select().from(inboxDedupe)).toEqual([]);
    const cursor = await cursorOf(consumer);
    expect(cursor).toMatchObject({ eventId: 0, attempts: 1, lastError: `Error: refused ${uuid(2)}` });
    expect(cursor?.retryAt?.getTime()).toBeGreaterThan(Date.now());
    // Backing off: not retried before retry_at.
    failing = false;
    expect(await processBatch(consumer)).toBe(0);
    await writer().update(outboxCursors).set({ retryAt: null }).where(eq(outboxCursors.consumer, consumer.name));
    // The rolled-back batch had handled event 1 in memory; the retry hands it over again.
    await drain(consumer, seen, [uuid(1), uuid(1), uuid(2)]);
    expect(await db().select({ id: inboxDedupe.activityId }).from(inboxDedupe)).toHaveLength(2);
  });

  test('backoff is capped at five minutes even after many attempts', async () => {
    const { consumer } = recorder({
      async handle() {
        throw new Error('poison');
      },
    });
    await ensureCursors([consumer]);
    await writer().update(outboxCursors).set({ attempts: 60 }).where(eq(outboxCursors.consumer, consumer.name));
    await emit(post(1));
    await expect.poll(horizonPassedOutbox).toBe(true);
    await expect(processBatch(consumer)).rejects.toThrow('poison');
    const cursor = await cursorOf(consumer);
    expect(cursor?.attempts).toBe(61);
    const wait = (cursor?.retryAt?.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(4 * 60_000);
    expect(wait).toBeLessThanOrEqual(5 * 60_000);
  });

  test('a process killed inside a batch leaves no writes and no cursor advance', async () => {
    const { consumer } = recorder({ name: 'test.crash' });
    await ensureCursors([consumer]);
    await emit(post(1));
    await expect.poll(horizonPassedOutbox).toBe(true);
    const child = join(import.meta.dirname, '../testing/crash-consumer.ts');
    const exit = await new Promise<{ signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [child, consumer.name], { env: process.env }, (error, stdout, stderr) =>
        resolve({ signal: error?.signal ?? null, stdout, stderr }),
      );
    });
    expect(exit).toEqual({ signal: 'SIGKILL', stdout: 'written\n', stderr: '' });
    expect(await db().select().from(inboxDedupe)).toEqual([]);
    expect(await cursorOf(consumer)).toMatchObject({ eventId: 0, attempts: 0 });
  });

  test('a consumer can chain an event in its batch transaction', async () => {
    const first = recorder({
      name: 'test.first',
      async handle(event, t) {
        if (event.type === 'post.created') await t.emit(comment(Number(event.postId.slice(-12)) + 100));
      },
    });
    const second = recorder({ name: 'test.second', events: ['comment.created'] });
    await ensureCursors([first.consumer, second.consumer]);
    await emit(post(1));
    await drain(first.consumer, first.seen, [uuid(1)]);
    await drain(second.consumer, second.seen, [uuid(101)]);
  });
});

describe('worker loop', () => {
  test('wakes on commit and stops on abort', async () => {
    const { seen, consumer } = recorder();
    const controller = new AbortController();
    const running = runOutboxWorker({ signal: controller.signal, consumers: [consumer], pollMs: 60_000 });
    await expect.poll(async () => (await db().select().from(outboxCursors)).length).toBe(1);
    await emit(post(7));
    await expect.poll(() => seen, { timeout: 5_000 }).toEqual([uuid(7)]);
    controller.abort();
    await running;
  });

  test('delivers by polling when no NOTIFY arrives', async () => {
    const { seen, consumer } = recorder();
    const controller = new AbortController();
    const running = runOutboxWorker({ signal: controller.signal, consumers: [consumer], pollMs: 50 });
    await expect.poll(async () => (await db().select().from(outboxCursors)).length).toBe(1);
    // A raw insert, outside tx(): no pg_notify, so only the poll can find it.
    const event = post(8);
    await writer().insert(outbox).values({ type: event.type, v: event.v, payload: event });
    await expect.poll(() => seen, { timeout: 5_000 }).toEqual([uuid(8)]);
    controller.abort();
    await running;
  });

  test('warns when a long write transaction holds back the horizon', async () => {
    const { consumer } = recorder();
    const slow = heldOpen(post(1));
    await slow.started;
    const lags: OldestTransaction[] = [];
    const controller = new AbortController();
    const running = runOutboxWorker({
      signal: controller.signal,
      consumers: [consumer],
      pollMs: 50,
      lagWarningSeconds: 0,
      onLag: (oldest) => lags.push(oldest),
    });
    await expect.poll(() => lags.length).toBeGreaterThan(0);
    controller.abort();
    await running;
    // The warning is cluster-wide (another lane's transaction may be the oldest); this database's oldest is the slow one.
    const database = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
    expect(await oldestWriteTransaction(database)).toMatchObject({ database, application: 'peblish-write' });
    await slow.commit();
  });
});
