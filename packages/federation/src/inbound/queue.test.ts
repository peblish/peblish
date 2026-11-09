import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { posts, votes } from '@peblish/core/db/tables/content';
import { inboxDedupe, inboxRaw } from '@peblish/core/db/tables/federation';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { inboxState, seedInboundWorld, seedInboxRow } from '@peblish/core/testing/seed-fed-b';
import { processRow } from './pipeline.ts';
import { ClaimLost, leasePending, leaseSeconds, maxAttempts, renewLease, retryLater, settleAlone } from './queue.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { activityId, addressedToCommunity, hosts, PUBLIC } from './test-support.ts';

// A worker whose lease ran out and whose row was leased again must not settle, retry or renew
// it: the claim generation (`attempts`) it holds no longer matches.

const lemmy = 'https://lemmy.test';
let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
});

const like = () => ({
  id: activityId(lemmy, 'like'),
  type: 'Like',
  actor: hosts.lemmyuser,
  object: hosts.t1,
  ...addressedToCommunity(hosts.spike),
});
const create = () => ({
  id: activityId(lemmy, 'create'),
  type: 'Create',
  actor: hosts.lemmyuser,
  object: {
    id: `${lemmy}/post/queue`,
    type: 'Page',
    attributedTo: hosts.lemmyuser,
    name: 'Queued',
    content: '<p>body</p>',
    published: '2026-11-09T10:00:00Z',
    audience: hosts.spike,
    to: [hosts.spike, PUBLIC],
  },
  ...addressedToCommunity(hosts.spike),
});

/** A pending row leased by one worker, whose lease then ran out and was taken by another: [stale claim, current claim]. */
async function takenOver(json: Record<string, unknown>) {
  const row = await seedInboxRow(JSON.stringify(json), { attempts: 0, activityId: json.id as string });
  const [stale] = await leasePending(1);
  await writer()
    .update(inboxRaw)
    .set({ leaseUntil: new Date(Date.now() - 1000) })
    .where(eq(inboxRaw.id, row.id));
  const [current] = await leasePending(1);
  expect([stale?.id, stale?.attempts, current?.attempts]).toEqual([row.id, 1, 2]);
  return [stale!, current!] as const;
}

describe('a worker that lost its lease', () => {
  test('cannot settle, retry or renew the row, and the worker that holds it can', async () => {
    const [stale, current] = await takenOver(like());
    await expect(settleAlone(stale, { state: 'applied', error: null })).rejects.toBeInstanceOf(ClaimLost);
    await expect(renewLease(stale)).rejects.toBeInstanceOf(ClaimLost);
    await retryLater(stale, new Error('the peer was down'));
    await retryLater({ ...stale, attempts: maxAttempts }, new Error('and still down'));
    const [row] = await db().select().from(inboxRaw).where(eq(inboxRaw.id, stale.id));
    expect(row).toMatchObject({ state: 'pending', error: null, attempts: 2 });

    await renewLease(current);
    await settleAlone(current, { state: 'skipped', error: 'duplicate' });
    expect(await inboxState(current.id)).toEqual({ state: 'skipped', error: 'duplicate' });
    // A settled row is nobody's to settle again.
    await expect(settleAlone(current, { state: 'applied', error: null })).rejects.toBeInstanceOf(ClaimLost);
  });

  test('rolls back what it applied when it finds the row taken, so only the holder applies', async () => {
    const [stale, current] = await takenOver(create());
    await expect(processRow(stale)).rejects.toBeInstanceOf(ClaimLost);
    expect(
      await db()
        .select()
        .from(posts)
        .where(eq(posts.apId, `${lemmy}/post/queue`)),
    ).toEqual([]);
    expect((await inboxState(stale.id))?.state).toBe('pending');

    expect(await processRow(current)).toEqual({ state: 'applied', error: null });
    expect(
      await db()
        .select()
        .from(posts)
        .where(eq(posts.apId, `${lemmy}/post/queue`)),
    ).toHaveLength(1);
  });
});

describe('a batch whose row is taken while its members are applied', () => {
  test('rolls back the member in flight, and the worker that holds the row applies them all', async () => {
    const vote = (actor: string) => ({ id: activityId(lemmy, 'like'), type: 'Like', actor, object: world.t2.apId, audience: hosts.lab });
    const batch = {
      id: activityId(lemmy, 'announce'),
      type: 'Announce',
      actor: hosts.lab,
      to: [PUBLIC],
      object: [vote(hosts.lemmyuser), vote(hosts.lemmyadmin)],
    };
    await seedInboxRow(JSON.stringify(batch), { attempts: 0, activityId: batch.id });
    const [claim] = await leasePending(1);
    // The lease is taken by another worker after the first member is applied and before it commits.
    let taken = false;
    const takeIt = async () => {
      if (taken) return;
      taken = true;
      await writer()
        .update(inboxRaw)
        .set({ attempts: sql`${inboxRaw.attempts} + 1` })
        .where(eq(inboxRaw.id, claim!.id));
    };
    await expect(processRow(claim!, { afterApply: takeIt })).rejects.toBeInstanceOf(ClaimLost);
    expect(await db().select().from(votes)).toEqual([]);
    expect(await db().select().from(inboxDedupe)).toEqual([]);

    expect(await processRow({ ...claim!, attempts: claim!.attempts + 1 })).toEqual({ state: 'applied', error: null });
    expect(await db().select().from(votes)).toHaveLength(2);
  });
});

describe('the lease of a row being worked on', () => {
  test('is renewed by a full period, and again by each fetch the delivery makes', async () => {
    const row = await seedInboxRow(
      JSON.stringify({ ...like(), id: 'https://elsewhere.test/like/1', actor: 'https://elsewhere.test/u/x' }),
      {
        attempts: 1,
      },
    );
    const leaseUntil = async () => (await db().select().from(inboxRaw).where(eq(inboxRaw.id, row.id)))[0]?.leaseUntil?.getTime() ?? 0;
    await writer()
      .update(inboxRaw)
      .set({ leaseUntil: sql`now() + interval '1 second'` })
      .where(eq(inboxRaw.id, row.id));
    await renewLease(row);
    expect(await leaseUntil()).toBeGreaterThan(Date.now() + (leaseSeconds - 5) * 1000);

    await writer()
      .update(inboxRaw)
      .set({ leaseUntil: sql`now() + interval '1 second'` })
      .where(eq(inboxRaw.id, row.id));
    const seen: number[] = [];
    const { fetch } = stubFetch({});
    await processRow(row, {
      fetch: async (url, init) => {
        seen.push(await leaseUntil());
        return fetch(url, init);
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((until) => until > Date.now() + (leaseSeconds - 5) * 1000)).toBe(true);
  });
});
