import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { db } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedBan, seedModerator, seedPost } from '../testing/seed-az.ts';
import { declareAge } from '../testing/seed-b1.ts';
import { seedFeedPost, seedFeedWorld, seedFollow } from '../testing/seed-c1.ts';
import { decodeCursor } from './cursor.ts';
import { periods, sorts, type Period } from './input.ts';
import { readFeed, type FeedRequest } from './read.ts';

// The feed read model against a real database: who sees what in each feed, the order of each
// sort, and that a page boundary never repeats or skips a post, even when a post is added
// between two page loads. The predicate registry is replaced by itself plus one test predicate.

vi.mock('../registry/feed-predicates.gen.ts', async (importOriginal) => {
  const { sql } = await import('drizzle-orm');
  const { posts } = await import('../db/tables/content.ts');
  const original = await importOriginal<typeof import('../registry/feed-predicates.gen.ts')>();
  return {
    feedPredicates: [...original.feedPredicates, { name: 'test-hide', where: () => sql`${posts.title} <> 'hidden by a predicate'` }],
  };
});

beforeEach(truncateAll);
afterEach(() => vi.useRealTimers());

const viewerOf = (person: { id: string }) => ({ actorId: person.id, siteRole: 'user' as const });
const titles = async (request: FeedRequest, viewer: ReturnType<typeof viewerOf> | null) =>
  (await readFeed(request, viewer)).items.map((item) => item.title);

/** Every page of a request, `size` posts at a time, with a hook that runs after the first page. */
async function walk(request: FeedRequest, viewer: ReturnType<typeof viewerOf> | null, size: number, afterFirst?: () => Promise<void>) {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 1; page < 50; page += 1) {
    const result = await readFeed({ ...request, cursor, limit: size }, viewer);
    ids.push(...result.items.map((item) => item.id));
    if (page === 1) await afterFirst?.();
    if (!result.next) break;
    cursor = result.next;
  }
  return ids;
}

describe('who sees what', () => {
  test('Subscribed is the accepted follows of open communities, and nothing for a signed-out viewer', async () => {
    const { instances, people, communities } = await seedFeedWorld();
    const post = (community: { id: string }, title: string, extra = {}) =>
      seedFeedPost(instances.local, community, people.author, { title, ...extra });
    await post(communities.news, 'followed local');
    await post(communities.remoteTech, 'followed remote');
    await post(communities.pending, 'pending follow');
    await post(communities.art, 'not followed');
    await post(communities.news, 'deleted post', { deletedAt: new Date() });
    await post(communities.news, 'removed post', { removedAt: new Date() });
    await seedFollow(people.viewer, communities.gone);
    await post(communities.gone, 'removed community');
    await seedFollow(people.viewer, communities.deleted);
    await post(communities.deleted, 'deleted community');
    const feed = { feed: 'subscribed', sort: 'new' } as const;
    expect(new Set(await titles(feed, viewerOf(people.viewer)))).toEqual(new Set(['followed local', 'followed remote']));
    expect(await titles(feed, viewerOf(people.stranger))).toEqual([]);
    expect(await titles(feed, null)).toEqual([]);
  });

  test('Local is the posts of local communities, All every open community, Popular All with a score of at least 2', async () => {
    const { instances, people, communities } = await seedFeedWorld();
    const post = (community: { id: string }, title: string, up = 0) =>
      seedFeedPost(instances.local, community, people.author, { title, up });
    await post(communities.news, 'local one', 2);
    await post(communities.remoteTech, 'remote one', 1);
    await post(communities.remoteTech, 'remote popular', 5);
    await post(communities.gone, 'in a removed community', 9);
    await post(communities.deleted, 'in a deleted community', 9);
    expect(new Set(await titles({ feed: 'local', sort: 'new' }, null))).toEqual(new Set(['local one']));
    expect(new Set(await titles({ feed: 'all', sort: 'new' }, null))).toEqual(new Set(['local one', 'remote one', 'remote popular']));
    expect(new Set(await titles({ feed: 'popular', sort: 'hot' }, null))).toEqual(new Set(['local one', 'remote popular']));
  });

  test('Moderating is the communities where the viewer is a moderator now; an expired or unconfirmed row grants nothing', async () => {
    const { instances, people, communities } = await seedFeedWorld();
    const post = (community: { id: string }, title: string) => seedFeedPost(instances.local, community, people.author, { title });
    await post(communities.news, 'in news');
    await post(communities.art, 'in art');
    await post(communities.remoteTech, 'in technology');
    await seedModerator(communities.art, people.viewer, { expiresAt: new Date(Date.now() - 1000) });
    await seedModerator(communities.remoteTech, people.viewer, {
      source: 'remote',
      verifiedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await titles({ feed: 'moderating', sort: 'new' }, viewerOf(people.viewer))).toEqual(['in news']);
    expect(await titles({ feed: 'moderating', sort: 'new' }, viewerOf(people.stranger))).toEqual([]);
    expect(await titles({ feed: 'moderating', sort: 'new' }, null)).toEqual([]);
  });

  test('a sensitive post is left out until the viewer has declared 16+', async () => {
    const { instances, people, communities } = await seedFeedWorld();
    await seedFeedPost(instances.local, communities.news, people.author, { title: 'plain' });
    await seedFeedPost(instances.local, communities.news, people.author, { title: 'flagged', sensitive: true });
    await seedFeedPost(instances.local, communities.adult, people.author, { title: 'in a sensitive community' });
    const all = { feed: 'all', sort: 'new' } as const;
    expect(await titles(all, null)).toEqual(['plain']);
    expect(await titles(all, viewerOf(people.stranger))).toEqual(['plain']);
    await declareAge(people.stranger);
    expect(new Set(await titles(all, viewerOf(people.stranger)))).toEqual(new Set(['plain', 'flagged', 'in a sensitive community']));
  });

  test('every registered predicate applies: a test predicate removes its row from every feed', async () => {
    const { instances, people, communities } = await seedFeedWorld();
    await seedFeedPost(instances.local, communities.news, people.author, { title: 'shown', up: 3 });
    await seedFeedPost(instances.local, communities.news, people.author, { title: 'hidden by a predicate', up: 3 });
    for (const feed of ['subscribed', 'local', 'all', 'popular', 'moderating'] as const)
      for (const sort of sorts) expect(await titles({ feed, sort }, viewerOf(people.viewer)), `${feed} ${sort}`).toEqual(['shown']);
  });

  test('a post by a banned author or in a community the viewer was banned from still shows: bans gate writes, not reads', async () => {
    const { instances, people, communities } = await seedFeedWorld();
    await seedBan(communities.news, people.viewer);
    await seedFeedPost(instances.local, communities.news, people.author, { title: 'readable' });
    expect(await titles({ feed: 'all', sort: 'new' }, viewerOf(people.viewer))).toEqual(['readable']);
  });
});

describe('the sorts', () => {
  test('New and Old order by date, and equal dates by id', async () => {
    const { instances, people, communities } = await seedFeedWorld();
    const tie = new Date(Date.now() - 60_000);
    const make = (title: string, publishedAt: Date) => seedPost(instances.local, communities.news, people.author, { title, publishedAt });
    await make('oldest', new Date(Date.now() - 3_600_000));
    const a = await make('tie a', tie);
    const b = await make('tie b', tie);
    await make('newest', new Date(Date.now() - 1_000));
    const [first, second] = a.id < b.id ? ['tie a', 'tie b'] : ['tie b', 'tie a'];
    expect(await titles({ feed: 'all', sort: 'new' }, null)).toEqual(['newest', second, first, 'oldest']);
    expect(await titles({ feed: 'all', sort: 'old' }, null)).toEqual(['oldest', first, second, 'newest']);
  });

  test('Top orders by score inside its window and all time has none', async () => {
    const { instances, people, communities } = await seedFeedWorld();
    const hour = 3_600_000;
    const make = (title: string, ago: number, up: number, down = 0) =>
      seedFeedPost(instances.local, communities.news, people.author, { title, ago, up, down });
    await make('minutes ago', 10 * 60_000, 3);
    await make('three hours', 3 * hour, 9);
    await make('ten hours', 10 * hour, 20);
    await make('three days', 72 * hour, 50, 2);
    await make('two months', 60 * 24 * hour, 400);
    const expected: Record<Period, string[]> = {
      '1h': ['minutes ago'],
      '6h': ['three hours', 'minutes ago'],
      '12h': ['ten hours', 'three hours', 'minutes ago'],
      day: ['ten hours', 'three hours', 'minutes ago'],
      week: ['three days', 'ten hours', 'three hours', 'minutes ago'],
      month: ['three days', 'ten hours', 'three hours', 'minutes ago'],
      year: ['two months', 'three days', 'ten hours', 'three hours', 'minutes ago'],
      all: ['two months', 'three days', 'ten hours', 'three hours', 'minutes ago'],
    };
    for (const period of periods) expect(await titles({ feed: 'all', sort: 'top', period }, null), period).toEqual(expected[period]);
  });

  test('Hot ranks by Lemmy’s formula, and what is older than a week follows, newest first', async () => {
    const now = new Date('2026-11-09T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'], now });
    const { instances, people, communities } = await seedFeedWorld();
    const hour = 3_600_000;
    const rank = (score: number, hours: number) => Math.log10(Math.max(1, score + 3)) / (hours + 2) ** 1.8;
    const specs = [
      { title: 'fresh and quiet', hours: 1, up: 0 },
      { title: 'fresh and loved', hours: 2, up: 40 },
      { title: 'a day old, very loved', hours: 24, up: 900 },
      { title: 'fresh and hated', hours: 1, up: 0, down: 30 },
      { title: 'six days old', hours: 6 * 24, up: 5000 },
      { title: 'eight days old, loved', hours: 8 * 24, up: 5000 },
      { title: 'ten days old', hours: 10 * 24, up: 1 },
    ];
    for (const { title, hours, up, down = 0 } of specs)
      await seedFeedPost(instances.local, communities.news, people.author, { title, ago: hours * hour, up, down });
    const ranked = specs
      .filter(({ hours }) => hours < 7 * 24)
      .map(({ title, hours, up, down = 0 }) => ({ title, hours, value: rank(up - down, hours) }))
      // A post scoring -2 or less has a rank of zero; equal ranks fall back to the newer post.
      .sort((a, b) => b.value - a.value || a.hours - b.hours)
      .map(({ title }) => title);
    const feed = { feed: 'all', sort: 'hot' } as const;
    expect(await titles(feed, null)).toEqual([...ranked, 'eight days old, loved', 'ten days old']);

    // The cursor carries the last row's rank, and continues past the week by date.
    const first = await readFeed({ ...feed, limit: 2 }, null);
    const expected = specs.find(({ title }) => title === first.items[1]?.title)!;
    expect(decodeCursor(first.next ?? undefined)?.rank).toBeCloseTo(rank(expected.up - (expected.down ?? 0), expected.hours), 12);
    expect(await walk(feed, null, 2)).toHaveLength(specs.length);
    const tail = await readFeed({ ...feed, limit: 2, cursor: (await readFeed({ ...feed, limit: 5 }, null)).next ?? undefined }, null);
    expect(tail.items.map((item) => item.title)).toEqual(['eight days old, loved', 'ten days old']);
    expect(decodeCursor(tail.next ?? undefined)).toBeNull();
  });
});

describe('keyset pagination', () => {
  /** Twelve posts with ties in date and in score across two communities; two are older than a week. */
  async function seedTies() {
    const world = await seedFeedWorld();
    const { instances, people, communities } = world;
    const hour = 3_600_000;
    const sameMoment = new Date(Date.now() - 3 * hour);
    const ages = [sameMoment, sameMoment, sameMoment, sameMoment, sameMoment, sameMoment, 8, 20, 30, 100, 9 * 24, 12 * 24];
    for (const [n, age] of ages.entries())
      await seedPost(instances.local, n % 2 ? communities.news : communities.remoteTech, people.author, {
        title: `tied ${n}`,
        publishedAt: age instanceof Date ? age : new Date(Date.now() - age * hour),
        upvotes: n % 3,
      });
    return world;
  }

  const requests: [string, FeedRequest][] = [
    ...sorts.map((sort): [string, FeedRequest] => [sort, { feed: 'all', sort }]),
    ['top day', { feed: 'all', sort: 'top', period: 'day' }],
    ['top week', { feed: 'all', sort: 'top', period: 'week' }],
  ];

  test.each(requests)(
    '%s: pages join up without a repeat or a gap, also when a post is added after the first page',
    async (_label, request) => {
      const { instances, people, communities } = await seedTies();
      const whole = (await readFeed({ ...request, limit: 50 }, null)).items.map((item) => item.id);
      expect(new Set(whole).size).toBe(whole.length);
      const paged = await walk(request, null, 5, async () => {
        // Arrives after the first page: newer and better than all of them, and one backdated by a day.
        await seedFeedPost(instances.local, communities.news, people.author, { title: 'late', up: 999 });
        await seedPost(instances.local, communities.news, people.author, {
          title: 'late, backdated',
          publishedAt: new Date(Date.now() - 3_600_000),
          upvotes: 1,
        });
      });
      // Whatever the late posts do to what is ahead of the cursor, nothing already read comes back and nothing that was there is missed.
      expect(new Set(paged).size).toBe(paged.length);
      const late = await db()
        .select({ id: posts.id })
        .from(posts)
        .where(sql`${posts.title} like 'late%'`);
      expect(paged.filter((id) => !late.some((row) => row.id === id))).toEqual(whole);
    },
  );

  test('a cursor from another sort or period is ignored, and so is a garbled one', async () => {
    const { instances, people, communities } = await seedFeedWorld();
    for (let n = 0; n < 4; n += 1)
      await seedFeedPost(instances.local, communities.news, people.author, { title: `p${n}`, ago: n * 1000, up: n });
    const firstOfNew = await readFeed({ feed: 'all', sort: 'new', limit: 2 }, null);
    const fresh = await titles({ feed: 'all', sort: 'old', limit: 2 }, null);
    expect(await titles({ feed: 'all', sort: 'old', limit: 2, cursor: firstOfNew.next ?? undefined }, null)).toEqual(fresh);
    expect(await titles({ feed: 'all', sort: 'old', limit: 2, cursor: 'not-a-cursor' }, null)).toEqual(fresh);
    expect(await titles({ feed: 'all', sort: 'old', limit: 2, cursor: Buffer.from('{"v":1}').toString('base64url') }, null)).toEqual(fresh);
  });

  test('the last page has no next, and an empty feed is an empty page', async () => {
    const { instances, people, communities } = await seedFeedWorld();
    expect(await readFeed({ feed: 'all', sort: 'hot' }, null)).toEqual({ items: [], next: null });
    await seedFeedPost(instances.local, communities.news, people.author, { title: 'only' });
    const page = await readFeed({ feed: 'all', sort: 'hot', limit: 1 }, null);
    expect([page.items.length, page.next]).toEqual([1, null]);
  });
});

describe('the views', () => {
  test('a feed hands out views in order with the viewer’s own vote', async () => {
    const { instances, people, communities } = await seedFeedWorld();
    const first = await seedFeedPost(instances.local, communities.news, people.author, { title: 'voted', ago: 1000, up: 1 });
    await seedFeedPost(instances.local, communities.news, people.author, { title: 'unvoted', ago: 2000 });
    const { votes } = await import('../db/tables/content.ts');
    await writer()
      .insert(votes)
      .values({
        apId: `https://feddit.test/vote/${first.id}`,
        local: true,
        instanceId: instances.local.id,
        voterId: people.viewer.id,
        postId: first.id,
        value: 1,
      });
    const { items } = await readFeed({ feed: 'all', sort: 'new' }, viewerOf(people.viewer));
    expect(items.map((item) => [item.title, item.myVote, item.community.handle])).toEqual([
      ['voted', 1, 'news'],
      ['unvoted', 0, 'news'],
    ]);
  });
});
