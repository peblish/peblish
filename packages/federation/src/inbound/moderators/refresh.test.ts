import { beforeEach, describe, expect, test, vi } from 'vitest';
import { db } from '@peblish/core/db/read';
import {
  communitiesDueForMirror,
  failingMirrorBackoffMs,
  forgetDeferredMirrors,
  unreachableMirrorBackoffMs,
} from '@peblish/core/remote/moderators';
import { truncateAll } from '@peblish/core/testing/db';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { seedFollow, seedInboundWorld, seedPeerActor } from '@peblish/core/testing/seed-fed-b';
import { resetKeyFetchBudget } from '../throttle.ts';
import { mirrorDue } from './refresh.ts';

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  forgetDeferredMirrors();
  world = await seedInboundWorld();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/** Another remote community alice follows, created after the ones before it (the job takes the oldest first). */
async function follow(name: string) {
  const community = await seedPeerActor(world.instances.lemmy, 'Group', name);
  await seedFollow(world.alice, community, `https://fed-b.test/ap/activity/follow-${name}`);
  return community;
}

describe('the moderators job with communities that fail', () => {
  test('twenty-odd failing communities do not keep the one behind them from being mirrored', async () => {
    // lab and fake (seeded with the world) and 24 more all fail; the last one answers.
    for (let n = 0; n < 24; n++) await follow(`down${n}`);
    const good = await follow('good');
    const collection = `${good.apId}/moderators`;
    const { fetch, requests } = stubFetch({ [collection]: { body: { type: 'OrderedCollection', id: collection, orderedItems: [] } } });

    // The first run takes twenty of the failing ones and none of them is asked again.
    expect(await mirrorDue({ fetch, limit: 20 })).toBe(0);
    const asked = requests.length;
    expect(asked).toBe(20);
    // The second reaches the rest, the good one among them.
    expect(await mirrorDue({ fetch, limit: 20 })).toBe(1);
    expect(requests.slice(asked).map((request) => request.url)).toContain(collection);
    expect(requests.slice(asked)).toHaveLength(7);
  });

  test('a community whose collection cannot be read waits an hour, one whose server is failing a quarter of one', async () => {
    const unreadable = await follow('unreadable');
    const failing = await follow('failing');
    const { fetch } = stubFetch({ [`${failing.apId}/moderators`]: { status: 503 } });
    await mirrorDue({ fetch, limit: 100 });

    const due = async (afterMs: number) =>
      (await communitiesDueForMirror(db(), 100, Date.now() + afterMs)).map((community) => community.apId);
    expect(await due(failingMirrorBackoffMs - 60_000)).not.toContain(failing.apId);
    expect(await due(failingMirrorBackoffMs + 60_000)).toContain(failing.apId);
    expect(await due(unreachableMirrorBackoffMs - 60_000)).not.toContain(unreadable.apId);
    expect(await due(unreachableMirrorBackoffMs + 60_000)).toContain(unreadable.apId);
  });
});
