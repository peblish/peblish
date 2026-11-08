import { beforeEach, describe, expect, test } from 'vitest';
import { ensureCursors, processBatch } from '../outbox/worker.ts';
import { truncateAll } from '../testing/db.ts';
import { seedModerator, seedPost } from '../testing/seed-az.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { tx } from '../tx/tx.ts';
import { consumer } from './consumer.ts';
import { ModeratorCache, moderatorCache } from './moderators-cache.ts';

const community = '0190f1a0-0000-7000-8000-000000000001';
const actor = (n: number) => `0190f1a0-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;

describe('ModeratorCache', () => {
  test('holds at most maxEntries, dropping the least recently used first', () => {
    const cache = new ModeratorCache({ maxEntries: 3 });
    for (const n of [1, 2, 3]) cache.set(community, actor(n), 'moderator', null);
    expect(cache.get(community, actor(1))).toBe('moderator'); // 1 is now the most recent
    cache.set(community, actor(4), 'owner', null);
    expect(cache.size).toBe(3);
    expect([1, 2, 3, 4].map((n) => cache.get(community, actor(n)))).toEqual(['moderator', undefined, 'moderator', 'owner']);
  });

  test("an entry lives for the TTL, or until its row's own expiry when that comes first", () => {
    let now = 1_000_000;
    const cache = new ModeratorCache({ ttlMs: 60_000, now: () => now });
    cache.set(community, actor(1), 'moderator', null);
    cache.set(community, actor(2), 'moderator', new Date(now + 10_000));
    now += 10_000;
    expect([cache.get(community, actor(1)), cache.get(community, actor(2))]).toEqual(['moderator', undefined]);
    now += 50_000;
    expect(cache.get(community, actor(1))).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

beforeEach(truncateAll);

async function setup() {
  const instance = await seedInstance('feddit.test');
  const moderator = await seedActor(instance, 'Person', 'moderator');
  const group = await seedActor(instance, 'Group', 'announcements');
  await seedModerator(group, moderator);
  const post = await seedPost(instance, group, moderator);
  return { moderator, group, post };
}

test('a mod.role event drops the pair it names, through the registered consumer', async () => {
  const { moderator, group } = await setup();
  const cache = moderatorCache();
  cache.clear();
  cache.set(group.id, moderator.id, 'moderator', null);
  cache.set(group.id, actor(9), 'moderator', null);
  await ensureCursors([consumer]);
  await tx(async (t) => {
    await t.emit({
      type: 'mod.role',
      v: 1,
      moderatorId: null,
      modlogId: actor(50),
      local: true,
      communityId: group.id,
      actorId: moderator.id,
      role: null,
    });
  });
  // processBatch reads below the cluster's oldest open transaction, which another lane may hold.
  await expect
    .poll(async () => {
      await processBatch(consumer);
      return cache.get(group.id, moderator.id);
    })
    .toBeUndefined();
  expect(cache.get(group.id, actor(9))).toBe('moderator');
});
