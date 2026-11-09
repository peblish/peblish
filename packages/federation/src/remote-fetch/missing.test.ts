import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { posts, votes } from '@peblish/core/db/tables/content';
import { inboxRaw } from '@peblish/core/db/tables/federation';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { nodeInfoRoutes, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, inboxState, seedInboundWorld, seedInboxRow } from '@peblish/core/testing/seed-fed-b';
import { processPending } from '../inbound/job.ts';
import { processRow } from '../inbound/pipeline.ts';
import { resetKeyFetchBudget } from '../inbound/throttle.ts';
import { activityId } from '../inbound/test-support.ts';
import { fetchMissing, forgetMissingAttempts, missingAttemptCount } from './missing.ts';
import { fetchRemoteObject } from './object.ts';
import { remoteTtls } from './ttl.ts';
import { announceOf, lab, lemmy, lemmyPage, lemmyuser } from './test-support.ts';

const peer = (routes: Record<string, { status?: number; body?: unknown }>) =>
  stubFetch({ ...routes, ...nodeInfoRoutes('lemmy.test', 'lemmy') });
const offline = peer({});
const { retryAfterMs } = remoteTtls.missing;

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  forgetMissingAttempts();
  world = await seedInboundWorld();
});

/** A vote on `target`, announced by lab, as the pipeline skips it when it does not hold the post. */
const waitingVote = (target: string, type: 'Dislike' | 'Like' = 'Dislike') =>
  deliverRow(
    announceOf(lab, activityId(lemmy, 'announce'), { id: activityId(lemmy, type), type, actor: lemmyuser, object: target, audience: lab }),
    (row) => processRow(row, { fetch: offline.fetch }),
  );

describe('objects that skipped activities are waiting for', () => {
  test('are fetched from their own origin, stored, and the waiting vote is applied once', async () => {
    const target = `${lemmy}/post/400`;
    const waiting = await waitingVote(target);
    expect(waiting.stored).toEqual({ state: 'skipped', error: `target.missing ${target}` });

    const server = peer({ [target]: { body: lemmyPage(400) } });
    expect(await fetchMissing({ fetch: server.fetch, gapMs: 0 })).toEqual({ looked: 1, stored: 1 });
    expect(server.requests.filter((request) => request.url === target)).toHaveLength(1);
    expect((await db().select().from(posts).where(eq(posts.apId, target)))[0]).toMatchObject({
      communityId: expect.any(String),
      local: false,
    });
    expect((await inboxState(waiting.row.id))?.state).toBe('pending');

    await processPending();
    expect(await inboxState(waiting.row.id)).toEqual({ state: 'applied', error: null });
    expect(await db().select().from(votes).where(eq(votes.value, -1))).toHaveLength(1);

    // Nothing is waiting any more.
    expect(await fetchMissing({ fetch: server.fetch, gapMs: 0 })).toEqual({ looked: 0, stored: 0 });
    expect(server.requests.filter((request) => request.url === target)).toHaveLength(1);
  });

  test('are asked for again later when the peer is down, and never again when it says no', async () => {
    const down = `${lemmy}/post/410`;
    const gone = `${lemmy}/post/411`;
    await waitingVote(down);
    await waitingVote(gone);
    const server = peer({ [down]: { status: 503 }, [gone]: { status: 410 } });
    const now = Date.now();
    const run = (at: number) => fetchMissing({ fetch: server.fetch, gapMs: 0, now: at });
    const asks = (url: string) => server.requests.filter((request) => request.url === url).length;

    expect(await run(now)).toMatchObject({ looked: 2 });
    expect(await run(now + 30_000)).toMatchObject({ looked: 0 });
    expect(await run(now + retryAfterMs[0]! + 1000)).toMatchObject({ looked: 1 });
    expect(asks(down)).toBe(2);
    // The wait grows with each failure.
    expect(await run(now + retryAfterMs[0]! + 2000 + retryAfterMs[0]!)).toMatchObject({ looked: 0 });
    expect(await run(now + retryAfterMs[0]! + 2000 + retryAfterMs[1]!)).toMatchObject({ looked: 1 });
    expect(asks(down)).toBe(3);
    // A 410 settles it.
    expect(asks(gone)).toBe(1);
  });

  test('are asked for newest first, and never from this server itself', async () => {
    const targets = Array.from({ length: 30 }, (_, i) => `${lemmy}/post/${500 + i}`);
    for (const target of targets) await waitingVote(target);
    const own = `${new URL(world.community.apId).origin}/ap/post/9`;
    await waitingVote(own);
    const server = peer({});
    expect(await fetchMissing({ fetch: server.fetch, gapMs: 0 })).toEqual({ looked: remoteTtls.missing.perRun, stored: 0 });
    const asked = new Set(server.requests.map((request) => request.url));
    // A run takes 25. The newest are asked for (the very last wait was on ours, which is skipped), the oldest are left for later.
    expect(asked.has(targets[29]!)).toBe(true);
    expect(asked.has(targets[0]!)).toBe(false);
    expect(asked.has(own)).toBe(false);
  });

  test('are left alone when no remote community announced the activity', async () => {
    const target = `${lemmy}/post/420`;
    const direct = await deliverRow({ id: activityId(lemmy, 'like'), type: 'Like', actor: lemmyuser, object: target }, (row) =>
      processRow(row, { fetch: offline.fetch }),
    );
    expect(direct.stored?.error).toBe(`target.missing ${target}`);
    const server = peer({ [target]: { body: lemmyPage(420) } });
    expect(await fetchMissing({ fetch: server.fetch, gapMs: 0 })).toEqual({ looked: 0, stored: 0 });
    expect(server.requests).toHaveLength(0);
  });
});

/** A skipped row waiting for `target`, as the pipeline leaves it after an Announce by `community`. */
const waitingRow = (target: string, community: string, receivedAt = new Date()) =>
  seedInboxRow('{}', {
    state: 'skipped',
    error: `target.missing ${target}`,
    actorApId: community,
    activityId: activityId(lemmy, 'announce'),
    activityType: 'Announce',
    receivedAt,
    processedAt: receivedAt,
  });

describe('which waiting objects a run reaches', () => {
  test('an older fetchable object is reached past a crowd of newer ones on this server’s own origin', async () => {
    const hour = 60 * 60 * 1000;
    const old = `${lemmy}/post/700`;
    const own = new URL(world.community.apId).origin;
    // Far more waiting objects than a run reads, all newer, all on this server's own origin (never fetched).
    const crowd = 2500;
    expect(crowd).toBeGreaterThan(remoteTtls.missing.scan * 4);
    await writer()
      .insert(inboxRaw)
      .values(
        Array.from({ length: crowd }, (_, i) => ({
          body: new TextEncoder().encode('{}'),
          state: 'skipped' as const,
          error: `target.missing ${own}/ap/post/${i}`,
          actorApId: lab,
          activityId: `${lemmy}/activities/announce/${i}`,
          activityType: 'Announce',
          receivedAt: new Date(Date.now() - i * 1000),
        })),
      );
    await waitingRow(old, lab, new Date(Date.now() - hour));

    const server = peer({ [old]: { body: lemmyPage(700) } });
    expect(await fetchMissing({ fetch: server.fetch, gapMs: 0 })).toEqual({ looked: 1, stored: 1 });
    expect(server.requests.some((request) => request.url === old)).toBe(true);
  });

  test('an older fetchable object is reached past newer ones that are settled or backed off', async () => {
    const missing = remoteTtls.missing as { scan: number };
    const was = missing.scan;
    missing.scan = 30;
    try {
      const newer = Array.from({ length: 4 * remoteTtls.missing.perRun }, (_, i) => `${lemmy}/post/${800 + i}`);
      const now = Date.now();
      for (const [i, target] of newer.entries()) await waitingRow(target, lab, new Date(now - 60_000 - i * 1000));
      const old = `${lemmy}/post/799`;
      await waitingRow(old, lab, new Date(now - 24 * 60 * 60 * 1000));
      // Half of the newer ones are refused (settled), half are down (backed off).
      const server = peer({
        ...Object.fromEntries(newer.filter((_, i) => i % 2 === 0).map((target) => [target, { status: 503 }])),
        [old]: { body: lemmyPage(799) },
      });
      const looked: number[] = [];
      for (let attempt = 0; attempt < 4; attempt++) looked.push((await fetchMissing({ fetch: server.fetch, gapMs: 0, now })).looked);
      // Four runs of 25 take the 100 newer ones; none of them is asked for again, and the old one comes next.
      expect(looked).toEqual([25, 25, 25, 25]);
      expect(server.requests.some((request) => request.url === old)).toBe(false);
      expect(await fetchMissing({ fetch: server.fetch, gapMs: 0, now })).toEqual({ looked: 1, stored: 1 });
      expect(server.requests.filter((request) => request.url === newer[0])).toHaveLength(1);
    } finally {
      missing.scan = was;
    }
  });

  test('what one community got refused is not held against another that vouches for the same object', async () => {
    const target = `${lemmy}/post/710`;
    // The rogue community announced a vote on it: the post is in lab, so it refuses.
    await waitingRow(target, world.peers.fake.apId, new Date(Date.now() - 1000));
    const server = peer({ [target]: { body: lemmyPage(710) } });
    expect(await fetchMissing({ fetch: server.fetch, gapMs: 0 })).toEqual({ looked: 1, stored: 0 });
    expect(await db().select().from(posts).where(eq(posts.apId, target))).toEqual([]);

    // Lab announces a vote on the same object: it is asked for again, and stored.
    await waitingRow(target, lab);
    expect(await fetchMissing({ fetch: server.fetch, gapMs: 0 })).toEqual({ looked: 1, stored: 1 });
    // And the rogue community's row is not tried again.
    expect(await fetchMissing({ fetch: server.fetch, gapMs: 0 })).toEqual({ looked: 0, stored: 0 });
  });

  test('what it remembers is bounded and expires', async () => {
    const targets = Array.from({ length: 5 }, (_, i) => `${lemmy}/post/${720 + i}`);
    for (const target of targets) await waitingRow(target, lab);
    const server = peer({});
    const missing = remoteTtls.missing as { memoryCap: number };
    const was = missing.memoryCap;
    missing.memoryCap = 3;
    try {
      const now = Date.now();
      expect(await fetchMissing({ fetch: server.fetch, gapMs: 0, now })).toMatchObject({ looked: 5 });
      expect(missingAttemptCount()).toBe(3);
      // A settled object is asked for again after a day.
      forgetMissingAttempts();
      expect(await fetchMissing({ fetch: server.fetch, gapMs: 0, now })).toMatchObject({ looked: 5 });
      missing.memoryCap = was;
      forgetMissingAttempts();
      await fetchMissing({ fetch: server.fetch, gapMs: 0, now });
      expect(await fetchMissing({ fetch: server.fetch, gapMs: 0, now: now + remoteTtls.missing.settledForMs - 1000 })).toMatchObject({
        looked: 0,
      });
      expect(await fetchMissing({ fetch: server.fetch, gapMs: 0, now: now + remoteTtls.missing.settledForMs + 1000 })).toMatchObject({
        looked: 5,
      });
    } finally {
      missing.memoryCap = was;
    }
  });

  test('puts the rows back in line for an object that was stored but whose requeue was cut off', async () => {
    const target = `${lemmy}/post/730`;
    const waiting = await waitingVote(target);
    const server = peer({ [target]: { body: lemmyPage(730) } });
    const vouch = { community: { id: world.peers.lab.id, apId: lab }, announceApId: `${lemmy}/activities/announce/1` };
    await fetchRemoteObject(target, { vouch, fetch: server.fetch });
    // The crash between the store and the requeue: the row is skipped again, the post is held.
    await writer()
      .update(inboxRaw)
      .set({ state: 'skipped', error: `target.missing ${target}` })
      .where(eq(inboxRaw.id, waiting.row.id));

    expect(await fetchMissing({ fetch: server.fetch, gapMs: 0 })).toEqual({ looked: 0, stored: 0 });
    expect((await inboxState(waiting.row.id))?.state).toBe('pending');
    await processPending();
    expect(await inboxState(waiting.row.id)).toEqual({ state: 'applied', error: null });
  });
});
