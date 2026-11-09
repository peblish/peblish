import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { outboxEvents } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { tx } from '../tx/tx.ts';
import { backfillLimits, claimBackfill, queueBackfill, settleBackfill } from './backfill.ts';
import { backfills } from './tables.ts';

const now = new Date('2026-11-09T12:00:00Z');
const later = (ms: number) => new Date(now.getTime() + ms);

async function world() {
  await seedLocalInstance('rem.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const lab = await seedActor(lemmy, 'Group', 'lab', { apId: 'https://lemmy.test/c/lab', outboxUrl: 'https://lemmy.test/c/lab/outbox' });
  const principal = await systemPrincipal(db(), 'scheduled');
  const claim = async (at: Date) => {
    const decision = await authorize('remote.backfill_claim', principal, {});
    if (!decision.ok) throw new Error(decision.reason);
    return claimBackfill(decision.grant, { now: at });
  };
  const settle = async (result: Parameters<typeof settleBackfill>[1]) => {
    const decision = await authorize('remote.backfill_settle', principal, { communityId: lab.id });
    if (!decision.ok) throw new Error(decision.reason);
    return settleBackfill(decision.grant, result);
  };
  const queue = () => tx((t) => queueBackfill(t, lab.id));
  const row = async () => (await db().select().from(backfills).where(eq(backfills.communityId, lab.id)))[0];
  return { lab, claim, settle, queue, row };
}

const types = async () => (await outboxEvents()).map((event) => (event as { type: string }).type);

beforeEach(truncateAll);

describe('the backfill queue', () => {
  test('a queued community is claimed once, with the collections to read, and not again while it runs', async () => {
    const w = await world();
    await w.queue();
    await w.queue();
    expect(await w.claim(now)).toMatchObject({
      communityId: w.lab.id,
      apId: 'https://lemmy.test/c/lab',
      outboxUrl: 'https://lemmy.test/c/lab/outbox',
      attempt: 1,
    });
    expect(await w.claim(now)).toBeNull();
    expect(await w.row()).toMatchObject({ state: 'running', attempts: 1 });
    expect(await types()).toEqual(['backfill.started']);
  });

  test('a worker that died leaves a lease that runs out, and the next worker takes the backfill over', async () => {
    const w = await world();
    await w.queue();
    await w.claim(now);
    expect(await w.claim(later(backfillLimits.leaseMs - 1000))).toBeNull();
    expect(await w.claim(later(backfillLimits.leaseMs + 1000))).toMatchObject({ attempt: 2 });
  });

  test('a run to be tried again waits for its time; a finished one is queued again by the next accepted follow', async () => {
    const w = await world();
    await w.queue();
    await w.claim(now);
    const retryAt = later(5 * 60 * 1000);
    expect(await w.settle({ outcome: 'retry', posts: 3, comments: 0, note: 'the outbox is down', retryAt })).toEqual({ settled: true });
    expect(await w.claim(later(60 * 1000))).toBeNull();
    expect(await w.claim(later(6 * 60 * 1000))).toMatchObject({ attempt: 2 });

    expect(await w.settle({ outcome: 'done', posts: 4, comments: 2, note: null, now: later(7 * 60 * 1000) })).toEqual({ settled: true });
    expect(await w.row()).toMatchObject({ state: 'done', posts: 7, comments: 2 });
    expect(await types()).toEqual(['backfill.started', 'backfill.started', 'backfill.settled']);
    // Settling what is not running changes nothing.
    expect(await w.settle({ outcome: 'failed', posts: 0, comments: 0, note: 'late', now: later(8 * 60 * 1000) })).toEqual({
      settled: false,
    });

    await w.queue();
    expect(await w.row()).toMatchObject({ state: 'pending', attempts: 0, note: null });
    expect(await w.claim(later(9 * 60 * 1000))).toMatchObject({ attempt: 1 });
  });
});
