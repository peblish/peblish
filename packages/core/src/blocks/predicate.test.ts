import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { feedNames } from '../feeds/input.ts';
import { readFeed } from '../feeds/read.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { seedBlock } from '../testing/seed-e1.ts';
import { seedFeedPost, seedFollow } from '../testing/seed-c1.ts';
import { seedPerson } from '../testing/seed-f.ts';
import { actorBlockedBy, blockOf, blockedAmong } from './predicate.ts';
import { feedPredicate } from './feed-predicate.ts';

beforeEach(truncateAll);

/** A local instance, a remote one, two viewers and one post for every author and community pairing worth telling apart. */
async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const piefed = await seedInstance('piefed.test', false);
  const viewer = await seedPerson(local, 'viewer');
  const other = await seedPerson(local, 'other');
  const people = {
    friend: await seedActor(local, 'Person', 'friend'),
    pest: await seedActor(local, 'Person', 'pest'),
    lemmyPerson: await seedActor(lemmy, 'Person', 'on_lemmy'),
    piefedPerson: await seedActor(piefed, 'Person', 'on_piefed'),
  };
  const communities = {
    news: await seedActor(local, 'Group', 'news'),
    noise: await seedActor(local, 'Group', 'noise'),
    lemmyGroup: await seedActor(lemmy, 'Group', 'tech'),
  };
  const make = (title: string, instance: typeof local, community: { id: string }, author: { id: string }) =>
    seedFeedPost(instance, community, author, { title });
  await make('friend in news', local, communities.news, people.friend);
  await make('pest in news', local, communities.news, people.pest);
  await make('friend in noise', local, communities.noise, people.friend);
  await make('lemmy person in news', local, communities.news, people.lemmyPerson);
  await make('piefed person in news', local, communities.news, people.piefedPerson);
  await make('friend in lemmy group', lemmy, communities.lemmyGroup, people.friend);
  await make('piefed person in lemmy group', lemmy, communities.lemmyGroup, people.piefedPerson);
  return { local, lemmy, piefed, viewer, other, people, communities };
}

const titlesOf = async (viewer: { id: string } | null, feed: (typeof feedNames)[number] = 'all') =>
  (await readFeed({ feed, sort: 'new', limit: 50 }, viewer && { actorId: viewer.id, siteRole: 'user' })).items
    .map((item) => item.title)
    .sort();

/** The titles the viewer's blocks leave, asked of the predicate itself. */
const keptByPredicate = async (viewer: { id: string }) => {
  const condition = feedPredicate.where({ actorId: viewer.id });
  const rows = await db().select({ title: posts.title }).from(posts).where(condition);
  return rows.map((row) => row.title).sort();
};

describe('the block predicate in the feeds', () => {
  test('signed out and a viewer with no blocks see every post', async () => {
    const w = await world();
    expect(feedPredicate.where(null)).toBeUndefined();
    expect(await titlesOf(null)).toHaveLength(7);
    expect(await titlesOf(w.viewer)).toHaveLength(7);
  });

  test('a person block hides that person everywhere, for the blocker only', async () => {
    const w = await world();
    await seedBlock(w.viewer, w.people.pest);
    expect(await titlesOf(w.viewer)).not.toContain('pest in news');
    expect(await titlesOf(w.viewer)).toHaveLength(6);
    expect(await titlesOf(w.other)).toContain('pest in news');
    expect(await titlesOf(null)).toContain('pest in news');
  });

  test('a community block hides that community, and only it', async () => {
    const w = await world();
    await seedBlock(w.viewer, w.communities.noise);
    expect(await titlesOf(w.viewer)).toEqual((await titlesOf(w.other)).filter((title) => title !== 'friend in noise'));
  });

  test('an instance block hides its people and its communities', async () => {
    const w = await world();
    await seedBlock(w.viewer, { instance: w.lemmy });
    const kept = await titlesOf(w.viewer);
    expect(kept).not.toContain('lemmy person in news');
    expect(kept).not.toContain('friend in lemmy group');
    expect(kept).not.toContain('piefed person in lemmy group');
    expect(kept).toContain('piefed person in news');
    expect(kept).toHaveLength(4);
    expect(await titlesOf(w.other)).toHaveLength(7);
  });

  test('every feed hides what the blocker blocked', async () => {
    const w = await world();
    await seedBlock(w.viewer, w.people.pest);
    await seedBlock(w.viewer, w.communities.noise);
    await seedBlock(w.viewer, { instance: w.piefed });
    await seedFollow(w.viewer, w.communities.news);
    await seedFollow(w.viewer, w.communities.noise);
    for (const feed of feedNames) {
      const titles = await titlesOf(w.viewer, feed);
      for (const title of ['pest in news', 'friend in noise', 'piefed person in news', 'piefed person in lemmy group'])
        expect(titles, `${feed} shows "${title}"`).not.toContain(title);
    }
    expect(await titlesOf(w.viewer, 'subscribed')).toEqual(['friend in news', 'lemmy person in news']);
  });
});

describe('blockedAmong, blockOf and actorBlockedBy agree with the feed predicate', () => {
  test('a person, a community and an instance block', async () => {
    const w = await world();
    await seedBlock(w.viewer, w.people.pest);
    await seedBlock(w.viewer, w.communities.noise);
    await seedBlock(w.viewer, { instance: w.piefed });

    const everyone = [...Object.values(w.people), ...Object.values(w.communities), w.other];
    const blocked = await blockedAmong(
      db(),
      w.viewer.id,
      everyone.map((actor) => actor.id),
    );
    expect([...blocked].sort()).toEqual([w.people.pest.id, w.communities.noise.id, w.people.piefedPerson.id].sort());
    expect(
      await blockedAmong(
        db(),
        w.other.id,
        everyone.map((actor) => actor.id),
      ),
    ).toEqual(new Set());
    expect(await blockedAmong(db(), w.viewer.id, [])).toEqual(new Set());

    expect(await blockOf(db(), w.viewer.id, w.people.pest.id)).toBe('actor');
    expect(await blockOf(db(), w.viewer.id, w.communities.noise.id)).toBe('actor');
    expect(await blockOf(db(), w.viewer.id, w.people.piefedPerson.id)).toBe('instance');
    expect(await blockOf(db(), w.viewer.id, w.people.friend.id)).toBeNull();
    expect(await blockOf(db(), w.other.id, w.people.pest.id)).toBeNull();
    expect(await blockOf(db(), w.viewer.id, w.viewer.id)).toBeNull();

    // The same rule as SQL for a join: the people the viewer blocks, directly or by instance.
    const rows = await db().execute<{ name: string }>(
      sql`select name from actors as a where a.kind = 'Person' and ${actorBlockedBy(w.viewer.id, sql`a.id`)}`,
    );
    expect(rows.map((row) => row.name).sort()).toEqual(['on_piefed', 'pest']);

    // And over posts: what the predicate keeps is what blockedAmong lets through.
    expect(await keptByPredicate(w.viewer)).toEqual(['friend in news', 'friend in lemmy group', 'lemmy person in news'].sort());
  });
});
