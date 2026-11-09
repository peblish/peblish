import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { posts, votes } from '@peblish/core/db/tables/content';
import { truncateAll } from '@peblish/core/testing/db';
import { nodeInfoRoutes, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, inboxState, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { processPending } from '../inbound/job.ts';
import { processRow } from '../inbound/pipeline.ts';
import { resetKeyFetchBudget } from '../inbound/throttle.ts';
import { activityId } from '../inbound/test-support.ts';
import { fetchMissing, forgetMissingAttempts } from './missing.ts';
import { remoteTtls } from './ttl.ts';
import { announceOf, lab, lemmy, lemmyPage, lemmyuser } from './test-support.ts';

const peer = (routes: Record<string, { status?: number; body?: unknown }>) =>
  stubFetch({ ...routes, ...nodeInfoRoutes('lemmy.test', 'lemmy') });
const offline = peer({});
const { retryAfterMs } = remoteTtls.missing;

beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  forgetMissingAttempts();
  await seedInboundWorld();
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
