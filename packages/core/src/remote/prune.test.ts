import { asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { activities, inboxDedupe, inboxRaw } from '../db/tables/federation.ts';
import { outbox, outboxCursors } from '../db/tables/outbox.ts';
import { writer } from '../db/write.ts';
import { deliveries } from '../delivery/tables.ts';
import { throttles } from '../identity/tables.ts';
import { outboxSkipped } from '../outbox/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { outboxEvents, seedPost } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { daysAgo, seedDelivery, seedInbound } from '../testing/seed-rem.ts';
import { retention } from './prune.ts';
import { pruneOld, setOutboxConsumers } from './prune-run.ts';

const now = new Date('2026-11-09T12:00:00Z');
const days = (ms: number) => ms / (24 * 60 * 60 * 1000);

beforeEach(truncateAll);

describe('retention', () => {
  test('deletes settled inbox rows and deliveries past their window, never a pending one, and keeps the activity an inbox row produced', async () => {
    const { instanceActor } = await seedLocalInstance('rem.test');
    const lemmy = await seedInstance('lemmy.test', false);
    const bob = await seedActor(lemmy, 'Person', 'bob', { apId: 'https://lemmy.test/u/bob' });

    const old = days(retention.inboxRawMs) + 1;
    const stale = await seedInbound(bob, daysAgo(old, now), { state: 'applied' });
    await seedInbound(bob, daysAgo(old, now), { state: 'skipped' });
    await seedInbound(bob, daysAgo(old, now), { state: 'failed' });
    await seedInbound(bob, daysAgo(old, now), { state: 'pending' });
    await seedInbound(bob, daysAgo(days(retention.inboxRawMs) - 1, now), { state: 'applied' });
    await writer()
      .insert(activities)
      .values({ apId: 'https://lemmy.test/activities/1', type: 'Like', actorApId: bob.apId, local: false, raw: {}, inboxRawId: stale.id });

    const oldDelivery = days(retention.deliveriesMs) + 1;
    await seedDelivery(lemmy, instanceActor, { state: 'delivered', createdAt: daysAgo(oldDelivery, now) });
    await seedDelivery(lemmy, instanceActor, { state: 'failed', createdAt: daysAgo(oldDelivery, now) });
    await seedDelivery(lemmy, instanceActor, { state: 'skipped', createdAt: daysAgo(oldDelivery, now) });
    await seedDelivery(lemmy, instanceActor, { state: 'pending', createdAt: daysAgo(oldDelivery, now), settledAt: null });
    await seedDelivery(lemmy, instanceActor, { state: 'delivered', createdAt: daysAgo(days(retention.deliveriesMs) - 1, now) });

    expect(await pruneOld({ now })).toEqual({ inbox_raw: 3, deliveries: 3, inbox_dedupe: 0, throttles: 0, outbox: 0 });

    expect((await db().select().from(inboxRaw)).map((row) => row.state).sort()).toEqual(['applied', 'pending']);
    expect((await db().select().from(deliveries)).map((row) => row.state).sort()).toEqual(['delivered', 'pending']);
    expect((await db().select().from(activities).where(eq(activities.apId, 'https://lemmy.test/activities/1')))[0]?.inboxRawId).toBeNull();
    const pruned = (await outboxEvents()).filter((event) => (event as { type: string }).type === 'remote.pruned');
    expect(pruned).toMatchObject([
      { table: 'inbox_raw', rows: 3 },
      { table: 'deliveries', rows: 3 },
    ]);

    // Nothing left to prune: no event.
    expect(await pruneOld({ now })).toEqual({ inbox_raw: 0, deliveries: 0, inbox_dedupe: 0, throttles: 0, outbox: 0 });
    expect((await outboxEvents()).filter((event) => (event as { type: string }).type === 'remote.pruned')).toHaveLength(2);
  });
});

describe('the deliveries a withdrawal needs', () => {
  test('a boost’s deliveries outlive the window until an Undo takes it back; other old Announces go', async () => {
    const { instance: here, instanceActor } = await seedLocalInstance('rem.test');
    const masto = await seedInstance('masto.test', false);
    const news = await seedActor(here, 'Group', 'news');
    const author = await seedActor(here, 'Person', 'alice');
    const old = daysAgo(days(retention.deliveriesMs) + 1, now);
    const announce = async (objectApId: string) => {
      const apId = `https://rem.test/ap/activity/${crypto.randomUUID()}`;
      await writer().insert(activities).values({ apId, type: 'Announce', actorApId: news.apId, objectApId, local: true, raw: {} });
      await seedDelivery(masto, instanceActor, {
        activityApId: apId,
        activityType: 'Announce',
        objectApId,
        state: 'delivered',
        createdAt: old,
      });
      return apId;
    };
    const open = await announce((await seedPost(here, news, author)).apId);
    const undone = await announce((await seedPost(here, news, author)).apId);
    await writer()
      .insert(activities)
      .values({ apId: 'https://rem.test/ap/activity/undo', type: 'Undo', actorApId: news.apId, objectApId: undone, local: true, raw: {} });
    // An Announce of an activity (Announce(Create(Note)), a relayed vote): nothing to withdraw.
    await announce('https://rem.test/ap/activity/create-1');

    expect(await pruneOld({ now })).toMatchObject({ deliveries: 2 });
    expect((await db().select().from(deliveries)).map((row) => row.activityApId)).toEqual([open]);
  });
});

describe('retention of the bookkeeping tables', () => {
  test('deletes dedupe markers and ended rate limiter windows past their window, and no others', async () => {
    await seedLocalInstance('rem.test');
    const stale = (ms: number) => new Date(now.getTime() - ms - 60_000);
    const fresh = (ms: number) => new Date(now.getTime() - ms + 60_000);
    await writer()
      .insert(inboxDedupe)
      .values([
        { activityId: 'https://lemmy.test/activities/old', seenAt: stale(retention.inboxDedupeMs) },
        { activityId: 'https://lemmy.test/activities/new', seenAt: fresh(retention.inboxDedupeMs) },
      ]);
    await writer()
      .insert(throttles)
      .values([
        { scope: 'sign-in', key: 'ip:203.0.113.1', windowStart: stale(retention.throttlesMs), count: 4 },
        { scope: 'sign-in', key: 'ip:203.0.113.2', windowStart: fresh(retention.throttlesMs), count: 4 },
        { scope: 'password', key: 'id:mira@example.test', windowStart: now, count: 1 },
      ]);
    expect(await pruneOld({ now })).toEqual({ inbox_raw: 0, deliveries: 0, inbox_dedupe: 1, throttles: 1, outbox: 0 });
    expect((await db().select().from(inboxDedupe)).map((row) => row.activityId)).toEqual(['https://lemmy.test/activities/new']);
    expect((await db().select().from(throttles)).map((row) => row.key).sort()).toEqual(['id:mira@example.test', 'ip:203.0.113.2']);
    const pruned = (await outboxEvents()).filter((event) => (event as { type: string }).type === 'remote.pruned');
    expect(pruned).toMatchObject([
      { table: 'inbox_dedupe', rows: 1 },
      { table: 'throttles', rows: 1 },
    ]);
  });
});

describe('a prune run next to the inbox job', () => {
  test('leaves a row another transaction is changing, and never deletes one that was put back to pending meanwhile', async () => {
    await seedLocalInstance('rem.test');
    const lemmy = await seedInstance('lemmy.test', false);
    const bob = await seedActor(lemmy, 'Person', 'bob', { apId: 'https://lemmy.test/u/bob' });
    const old = days(retention.inboxRawMs) + 1;
    const waiting = await seedInbound(bob, daysAgo(old, now), { state: 'skipped', error: 'target.missing https://lemmy.test/post/1' });
    const settled = await seedInbound(bob, daysAgo(old, now), { state: 'applied' });

    let requeued!: () => void;
    const requeuing = new Promise<void>((resolve) => (requeued = resolve));
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => (commit = resolve));
    // The inbox job's requeue: the row goes back to pending in a transaction that has not committed yet.
    const requeue = writer().transaction(async (t) => {
      await t.update(inboxRaw).set({ state: 'pending', error: null, processedAt: null }).where(eq(inboxRaw.id, waiting.id));
      requeued();
      await committed;
    });
    await requeuing;

    // The prune does not wait for it: it takes the rows it can.
    expect(await pruneOld({ now })).toMatchObject({ inbox_raw: 1 });
    commit();
    await requeue;
    expect((await db().select().from(inboxRaw)).map((row) => [row.id, row.state])).toEqual([[waiting.id, 'pending']]);
    expect(settled.id).not.toBe(waiting.id);
    // And once it is pending it is never deleted, whatever its age.
    expect(await pruneOld({ now })).toMatchObject({ inbox_raw: 0 });
    expect(await db().select().from(inboxRaw)).toHaveLength(1);
  });
});

describe('retention of the outbox', () => {
  type Event = { id: number; txId: string };
  const old = new Date(now.getTime() - retention.outboxMs - 60_000);
  const fresh = new Date(now.getTime() - retention.outboxMs + 60_000);
  /** `count` events created at `createdAt`, in one transaction. */
  const seedEvents = async (createdAt: Date, count = 1) =>
    writer().execute<Event>(sql`
      insert into ${outbox} (type, v, payload, created_at)
      select 'test.event', 1, '{}'::jsonb, ${createdAt.toISOString()}::timestamptz from generate_series(1, ${count})
      returning id::int as id, tx_id::text as "txId"`);
  const seedEvent = async (createdAt: Date) => (await seedEvents(createdAt))[0]!;
  const cursorAt = (consumer: string, event: Event) =>
    writer()
      .insert(outboxCursors)
      .values({ consumer, txId: event.txId, eventId: event.id })
      .onConflictDoUpdate({ target: outboxCursors.consumer, set: { txId: event.txId, eventId: event.id } });
  const left = async () =>
    (await db().select({ id: outbox.id, type: outbox.type }).from(outbox).orderBy(asc(outbox.id)))
      .filter((row) => row.type === 'test.event')
      .map((row) => row.id);
  const prunedEvents = async () =>
    (await outboxEvents()).filter((event) => (event as { type: string; table?: string }).type === 'remote.pruned');

  test('deletes old events every registered consumer has passed; keeps newer ones, ones a consumer lags behind and skipped ones', async () => {
    await seedLocalInstance('rem.test');
    const first = await seedEvent(old);
    const skipped = await seedEvent(old);
    const recent = await seedEvent(fresh);
    const passed = await seedEvent(old);
    const ahead = await seedEvent(old);
    await cursorAt('fast', ahead);
    await cursorAt('slow', passed);
    // A renamed consumer's cursor, left at the start: it is not registered, so it holds nothing back.
    await cursorAt('retired', { id: 0, txId: '0' });
    await writer()
      .insert(outboxSkipped)
      .values({ consumer: 'fast', eventId: skipped.id, type: 'test.event', failures: 10, firstFailureAt: old, lastFailureAt: old });

    expect(await pruneOld({ now, consumers: ['fast', 'slow'] })).toMatchObject({ outbox: 2 });
    expect(await left()).toEqual([skipped.id, recent.id, ahead.id]);
    expect(first.id).toBeLessThan(passed.id);
    expect(await prunedEvents()).toMatchObject([{ table: 'outbox', rows: 2 }]);

    // Once the slow consumer has passed it too, the last old one goes.
    await cursorAt('slow', ahead);
    expect(await pruneOld({ now, consumers: ['fast', 'slow'] })).toMatchObject({ outbox: 1 });
    expect(await left()).toEqual([skipped.id, recent.id]);
  });

  test('prunes nothing while a registered consumer has no cursor yet, or when no consumer is named', async () => {
    await seedLocalInstance('rem.test');
    const event = await seedEvent(old);
    await cursorAt('fast', event);

    expect(await pruneOld({ now, consumers: ['fast', 'starting'] })).toMatchObject({ outbox: 0 });
    expect(await pruneOld({ now, consumers: [] })).toMatchObject({ outbox: 0 });
    // No consumer names given to the process (setOutboxConsumers): nothing either.
    expect(await pruneOld({ now })).toMatchObject({ outbox: 0 });
    expect(await left()).toEqual([event.id]);
    expect(await prunedEvents()).toEqual([]);

    expect(await pruneOld({ now, consumers: ['fast'] })).toMatchObject({ outbox: 1 });
  });

  test('takes the consumer names the worker entry set', async () => {
    await seedLocalInstance('rem.test');
    const event = await seedEvent(old);
    await cursorAt('fast', event);
    setOutboxConsumers(['fast']);
    try {
      expect(await pruneOld({ now })).toMatchObject({ outbox: 1 });
      expect(await left()).toEqual([]);
    } finally {
      setOutboxConsumers([]);
    }
  });

  test('deletes in batches, as the other tables do', async () => {
    await seedLocalInstance('rem.test');
    const events = await seedEvents(old, 2 * retention.batch + 1);
    await cursorAt('fast', events.at(-1)!);

    expect(await pruneOld({ now, consumers: ['fast'] })).toMatchObject({ outbox: 2 * retention.batch + 1 });
    expect(await left()).toEqual([]);
    expect(await prunedEvents()).toMatchObject([
      { table: 'outbox', rows: retention.batch },
      { table: 'outbox', rows: retention.batch },
      { table: 'outbox', rows: 1 },
    ]);
  });
});
