import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts } from '@peblish/core/db/tables/content';
import { deletionLedger } from '@peblish/core/db/tables/site';
import { truncateAll } from '@peblish/core/testing/db';
import { nodeInfoRoutes, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { resetKeyFetchBudget } from '../inbound/throttle.ts';
import { fetchRemoteObject, type Vouch } from './object.ts';
import { recheckObjects } from './recheck.ts';
import { lab, lemmy, lemmyNote, lemmyPage } from './test-support.ts';

let vouch: Vouch;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  const world = await seedInboundWorld();
  vouch = { community: { id: world.peers.lab.id, apId: lab }, announceApId: `${lemmy}/activities/announce/1` };
});

const serving = (routes: Record<string, { status?: number; body?: unknown }>) =>
  stubFetch({ ...routes, ...nodeInfoRoutes('lemmy.test', 'lemmy') });
const day = 24 * 60 * 60 * 1000;

describe('asking after the objects we hold', () => {
  test('soft-deletes the ones their server says are gone, once, and leaves the rest', async () => {
    const post = `${lemmy}/post/800`;
    const kept = `${lemmy}/post/801`;
    const note = `${lemmy}/comment/800`;
    const down = `${lemmy}/post/802`;
    const peer = serving({
      [post]: { body: lemmyPage(800) },
      [kept]: { body: lemmyPage(801) },
      [note]: { body: lemmyNote(800, post) },
      [down]: { body: lemmyPage(802) },
    });
    for (const target of [post, kept, note, down]) await fetchRemoteObject(target, { vouch, fetch: peer.fetch });
    // Held more than a day.
    const later = new Date(Date.now() + 2 * day);

    const answers = serving({
      [post]: { status: 410, body: { type: 'Tombstone', id: post } },
      [kept]: { body: lemmyPage(801) },
      [note]: { body: { type: 'Tombstone', id: note, formerType: 'Note' } },
      [down]: { status: 503 },
    });
    const run = await recheckObjects({ fetch: answers.fetch, gapMs: 0, now: later });
    expect(run.checked).toBeGreaterThanOrEqual(4);
    expect(run.gone).toBe(2);
    expect(run.unreachable).toBe(1);
    const gone = async (apId: string) => (await db().select().from(posts).where(eq(posts.apId, apId)))[0]?.deletedAt;
    expect(await gone(post)).toBeInstanceOf(Date);
    expect(await gone(kept)).toBeNull();
    expect(await gone(down)).toBeNull();
    expect((await db().select().from(comments).where(eq(comments.apId, note)))[0]?.deletedAt).toBeInstanceOf(Date);
    expect((await db().select().from(deletionLedger)).map((row) => row.reason).sort()).toEqual([
      'remote.object_gone',
      'remote.object_gone',
    ]);

    // Asked after once a day: nothing is due straight away.
    expect(await recheckObjects({ fetch: answers.fetch, gapMs: 0, now: later })).toEqual({ checked: 0, gone: 0, unreachable: 0 });
    // A day on, the server that was down is asked again.
    const tomorrow = new Date(later.getTime() + day + 1000);
    const back = serving({ [down]: { body: { type: 'Tombstone', id: down } }, [kept]: { body: lemmyPage(801) } });
    expect((await recheckObjects({ fetch: back.fetch, gapMs: 0, now: tomorrow })).gone).toBe(1);
    expect(await gone(down)).toBeInstanceOf(Date);
  });

  test('takes a bounded number a run', async () => {
    const targets = [810, 811, 812].map((n) => `${lemmy}/post/${n}`);
    const peer = serving(Object.fromEntries(targets.map((url, i) => [url, { body: lemmyPage(810 + i) }])));
    for (const target of targets) await fetchRemoteObject(target, { vouch, fetch: peer.fetch });
    const later = new Date(Date.now() + 2 * day);
    expect((await recheckObjects({ fetch: peer.fetch, gapMs: 0, now: later, limit: 2 })).checked).toBe(2);
  });
});
