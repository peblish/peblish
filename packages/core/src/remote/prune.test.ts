import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { activities, inboxRaw } from '../db/tables/federation.ts';
import { writer } from '../db/write.ts';
import { deliveries } from '../delivery/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { outboxEvents } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { daysAgo, seedDelivery, seedInbound } from '../testing/seed-rem.ts';
import { retention } from './prune.ts';
import { pruneOld } from './prune-run.ts';

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

    expect(await pruneOld({ now })).toEqual({ inbox_raw: 3, deliveries: 3 });

    expect((await db().select().from(inboxRaw)).map((row) => row.state).sort()).toEqual(['applied', 'pending']);
    expect((await db().select().from(deliveries)).map((row) => row.state).sort()).toEqual(['delivered', 'pending']);
    expect((await db().select().from(activities).where(eq(activities.apId, 'https://lemmy.test/activities/1')))[0]?.inboxRawId).toBeNull();
    const pruned = (await outboxEvents()).filter((event) => (event as { type: string }).type === 'remote.pruned');
    expect(pruned).toMatchObject([
      { table: 'inbox_raw', rows: 3 },
      { table: 'deliveries', rows: 3 },
    ]);

    // Nothing left to prune: no event.
    expect(await pruneOld({ now })).toEqual({ inbox_raw: 0, deliveries: 0 });
    expect((await outboxEvents()).filter((event) => (event as { type: string }).type === 'remote.pruned')).toHaveLength(2);
  });
});
