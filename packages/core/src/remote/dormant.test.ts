import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { writer } from '../db/write.ts';
import { inboxRaw } from '../db/tables/federation.ts';
import { instances } from '../db/tables/instances.ts';
import { deliveries } from '../delivery/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { outboxEvents } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { daysAgo, seedDelivery, seedInbound } from '../testing/seed-rem.ts';
import { dormancy, evaluateInstanceHealth, isDormant } from './dormant.ts';
import { instanceHealth } from './tables.ts';

const now = new Date('2026-11-09T12:00:00Z');
const hours = (n: number) => new Date(now.getTime() + n * 60 * 60 * 1000);

async function world() {
  const { instanceActor } = await seedLocalInstance('rem.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const piefed = await seedInstance('piefed.test', false);
  const bob = await seedActor(lemmy, 'Person', 'bob', { apId: 'https://lemmy.test/u/bob' });
  /** Failed deliveries to the instance, `ages` days old. */
  const fail = (instance: { id: string; domain: string }, ...ages: number[]) =>
    Promise.all(ages.map((age) => seedDelivery(instance, instanceActor, { state: 'failed', createdAt: daysAgo(age, now) })));
  return { instanceActor, lemmy, piefed, bob, fail };
}

const events = async () => (await outboxEvents()).map((event) => (event as { type: string }).type);
const stateOf = async (instanceId: string) =>
  (await db().select().from(instanceHealth).where(eq(instanceHealth.instanceId, instanceId)))[0];

beforeEach(truncateAll);

describe('becoming dormant', () => {
  test('deliveries that failed for a week with nothing heard back make an instance dormant, and only that instance', async () => {
    const w = await world();
    await w.fail(w.lemmy, 8, 5, 0.5);
    await w.fail(w.piefed, 6, 3, 0.5);
    expect(await evaluateInstanceHealth(now)).toEqual({ dormant: 1, revived: 0 });
    expect(await stateOf(w.lemmy.id)).toMatchObject({ state: 'dormant', failingSince: daysAgo(8, now), dormantSince: now });
    expect(await stateOf(w.piefed.id)).toBeUndefined();
    expect(await isDormant(w.lemmy.id, now)).toBe(true);
    expect(await isDormant(w.piefed.id, now)).toBe(false);
    expect(await events()).toEqual(['instance.dormant']);
    // Running again changes nothing and says nothing.
    expect(await evaluateInstanceHealth(now)).toEqual({ dormant: 0, revived: 0 });
    expect(await events()).toEqual(['instance.dormant']);
  });

  test('a delivery that succeeded since the failures began breaks the run', async () => {
    const w = await world();
    await w.fail(w.lemmy, 9, 8, 7, 0.5);
    await seedDelivery(w.lemmy, w.instanceActor, { state: 'delivered', createdAt: daysAgo(2, now) });
    expect(await evaluateInstanceHealth(now)).toEqual({ dormant: 0, revived: 0 });
    // The failures after the success are a new run, and it is young.
    await w.fail(w.lemmy, 1);
    expect(await evaluateInstanceHealth(now)).toEqual({ dormant: 0, revived: 0 });
  });

  test('an instance that sent us something within the week is not dormant', async () => {
    const w = await world();
    await w.fail(w.lemmy, 9, 4, 0.5);
    await seedInbound(w.bob, daysAgo(3, now));
    expect(await evaluateInstanceHealth(now)).toEqual({ dormant: 0, revived: 0 });
    // Silence past the window does not protect it.
    await writer().delete(inboxRaw);
    await seedInbound(w.bob, daysAgo(8, now));
    expect(await evaluateInstanceHealth(now)).toEqual({ dormant: 1, revived: 0 });
  });

  test('old failures we have stopped adding to, or fewer than three, are not a dead server', async () => {
    const w = await world();
    await w.fail(w.lemmy, 12, 10, 9);
    await w.fail(w.piefed, 9, 0.5);
    expect(await evaluateInstanceHealth(now)).toEqual({ dormant: 0, revived: 0 });
  });

  test('retrying deliveries count as failing, skipped ones do not', async () => {
    const w = await world();
    await seedDelivery(w.lemmy, w.instanceActor, { state: 'pending', attempts: 3, createdAt: daysAgo(8, now), settledAt: null });
    await seedDelivery(w.lemmy, w.instanceActor, { state: 'failed', createdAt: daysAgo(5, now) });
    await seedDelivery(w.lemmy, w.instanceActor, { state: 'skipped', createdAt: daysAgo(1, now) });
    expect(await evaluateInstanceHealth(now)).toEqual({ dormant: 0, revived: 0 });
    await seedDelivery(w.lemmy, w.instanceActor, { state: 'pending', attempts: 1, createdAt: daysAgo(1, now), settledAt: null });
    expect(await evaluateInstanceHealth(now)).toEqual({ dormant: 1, revived: 0 });
  });
});

describe('a dormant instance', () => {
  async function dormant() {
    const w = await world();
    await w.fail(w.lemmy, 8, 5, 0.5);
    await evaluateInstanceHealth(now);
    return w;
  }

  test('is skipped, except for one probe a day', async () => {
    const w = await dormant();
    expect(await isDormant(w.lemmy.id, hours(1))).toBe(true);
    expect(await isDormant(w.lemmy.id, hours(23))).toBe(true);
    // A day after it went dormant: the next delivery is the probe, the ones behind it are skipped.
    expect(await isDormant(w.lemmy.id, hours(24))).toBe(false);
    expect(await isDormant(w.lemmy.id, hours(24))).toBe(true);
    expect(await isDormant(w.lemmy.id, hours(47))).toBe(true);
    expect(await isDormant(w.lemmy.id, hours(48))).toBe(false);
    expect((await events()).filter((type) => type === 'instance.probed')).toHaveLength(2);
    expect(dormancy.probeEveryMs).toBe(24 * 60 * 60 * 1000);
  });

  test('is revived by a probe that was delivered', async () => {
    const w = await dormant();
    await isDormant(w.lemmy.id, hours(24));
    await seedDelivery(w.lemmy, w.instanceActor, { state: 'delivered', createdAt: hours(24), settledAt: hours(24) });
    expect(await evaluateInstanceHealth(hours(25))).toEqual({ dormant: 0, revived: 1 });
    expect(await stateOf(w.lemmy.id)).toMatchObject({ state: 'active', revivedAt: hours(25) });
    expect(await isDormant(w.lemmy.id, hours(26))).toBe(false);
    expect(await events()).toContain('instance.revived');
    // The failed rows are still there, but they came before the success: it stays active.
    expect(await evaluateInstanceHealth(hours(27))).toEqual({ dormant: 0, revived: 0 });
  });

  test('is revived by anything it sends, and not by silence', async () => {
    const w = await dormant();
    expect(await evaluateInstanceHealth(hours(30))).toEqual({ dormant: 0, revived: 0 });
    await seedInbound(w.bob, hours(31));
    expect(await evaluateInstanceHealth(hours(32))).toEqual({ dormant: 0, revived: 1 });
    expect(await isDormant(w.lemmy.id, hours(33))).toBe(false);
    const revived = (await outboxEvents()).find((event) => (event as { type: string }).type === 'instance.revived');
    expect(revived).toMatchObject({ by: 'inbound', domain: 'lemmy.test' });
  });

  test('stays dormant when the failed deliveries that proved it are pruned', async () => {
    const w = await dormant();
    await writer().delete(deliveries);
    expect(await evaluateInstanceHealth(hours(30))).toEqual({ dormant: 0, revived: 0 });
    expect(await isDormant(w.lemmy.id, hours(1))).toBe(true);
  });

  test('this server itself is never dormant', async () => {
    const w = await world();
    const [local] = await db().select().from(instances).where(eq(instances.local, true));
    await seedDelivery(local!, w.instanceActor, { state: 'failed', createdAt: daysAgo(9, now) });
    expect(await evaluateInstanceHealth(now)).toEqual({ dormant: 0, revived: 0 });
  });
});
