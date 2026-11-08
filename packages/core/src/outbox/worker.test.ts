import type { OutboxEvent } from '@peblish/schema/events';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { outboxCursors } from '../db/tables/outbox.ts';
import { truncateAll } from '../testing/db.ts';
import { tx } from '../tx/tx.ts';
import { defineConsumer, type Consumer } from './consumers.ts';
import { ensureCursors, processBatch, runOutboxWorker, type OldestTransaction } from './worker.ts';

const uuid = (n: number) => `0192f5a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const created = (n: number): OutboxEvent => ({
  type: 'post.created',
  v: 1,
  postId: uuid(n),
  communityId: uuid(0),
  authorId: uuid(0),
  local: true,
});

function recorder(fail?: (event: OutboxEvent) => boolean) {
  const seen: string[] = [];
  const consumer = defineConsumer({
    name: 'test.recorder',
    events: ['post.created'],
    async handle(event) {
      if (fail?.(event)) throw new Error(`refused ${event.postId}`);
      seen.push(event.postId);
    },
  });
  return { seen, consumer };
}

const emit = (...events: OutboxEvent[]) =>
  tx(async (t) => {
    for (const event of events) await t.emit(event);
  });

/** Opens a transaction that emits and then waits for `release` before committing. */
function heldOpen(event: OutboxEvent) {
  let release!: () => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => (ready = resolve));
  const done = tx(async (t) => {
    await t.emit(event);
    ready();
    await new Promise<void>((resolve) => (release = resolve));
  });
  return {
    started,
    commit: async () => {
      release();
      await done;
    },
  };
}

beforeEach(truncateAll);

describe('outbox worker', () => {
  test('a new consumer starts at now, then gets events in commit-safe order, once', async () => {
    await emit(created(1));
    const { seen, consumer } = recorder();
    await ensureCursors([consumer]);
    await emit(created(2), created(3));
    await emit(created(4));
    expect(await processBatch(consumer)).toBe(3);
    expect(await processBatch(consumer)).toBe(0);
    expect(seen).toEqual([uuid(2), uuid(3), uuid(4)]);
  });

  test('an earlier transaction that commits later is not skipped', async () => {
    const { seen, consumer } = recorder();
    await ensureCursors([consumer]);
    const slow = heldOpen(created(1));
    await slow.started;
    await emit(created(2));
    // The slow transaction holds back the snapshot horizon, so nothing is read past it yet.
    expect(await processBatch(consumer)).toBe(0);
    await slow.commit();
    expect(await processBatch(consumer)).toBe(2);
    expect(seen).toEqual([uuid(1), uuid(2)]);
  });

  test('a rolled-back transaction never reaches a consumer', async () => {
    const { seen, consumer } = recorder();
    await ensureCursors([consumer]);
    await expect(
      tx(async (t) => {
        await t.emit(created(1));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await processBatch(consumer)).toBe(0);
    expect(seen).toEqual([]);
  });

  test('a failing handler rolls back its batch and backs off without moving the cursor', async () => {
    let failing = true;
    const { seen, consumer } = recorder(() => failing);
    await ensureCursors([consumer]);
    await emit(created(1));
    await expect(processBatch(consumer)).rejects.toThrow(/refused/);
    const [cursor] = await db().select().from(outboxCursors).where(eq(outboxCursors.consumer, consumer.name));
    expect(cursor).toMatchObject({ eventId: 0, attempts: 1, lastError: `Error: refused ${uuid(1)}` });
    expect(cursor?.retryAt?.getTime()).toBeGreaterThan(Date.now());
    // Backing off: not retried before retry_at.
    failing = false;
    expect(await processBatch(consumer)).toBe(0);
    await tx(async (t) => {
      await t.db.update(outboxCursors).set({ retryAt: null }).where(eq(outboxCursors.consumer, consumer.name));
    });
    expect(await processBatch(consumer)).toBe(1);
    expect(seen).toEqual([uuid(1)]);
  });

  test('the worker loop wakes on commit and stops on abort', async () => {
    const { seen, consumer } = recorder();
    const controller = new AbortController();
    const consumers: Consumer[] = [consumer];
    const running = runOutboxWorker({ signal: controller.signal, consumers, pollMs: 60_000 });
    await expect.poll(async () => (await db().select().from(outboxCursors)).length).toBe(1);
    await emit(created(7));
    await expect.poll(() => seen, { timeout: 2_000 }).toEqual([uuid(7)]);
    controller.abort();
    await running;
  });

  test('the worker warns when a long write transaction holds back the horizon', async () => {
    const { consumer } = recorder();
    const slow = heldOpen(created(1));
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
    await slow.commit();
    expect(lags[0]).toMatchObject({ database: new URL(process.env.DATABASE_URL ?? '').pathname.slice(1), application: 'peblish-write' });
  });
});
