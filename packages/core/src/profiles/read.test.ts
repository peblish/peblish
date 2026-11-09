import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { hideNsfw, showNsfw, type NsfwChoice } from '../communities/gate.ts';
import { actors } from '../db/tables/actors.ts';
import { writer } from '../db/write.ts';
import { seedBlock } from '../testing/seed-e1.ts';
import { truncateAll } from '../testing/db.ts';
import { seedComment, seedModerator, seedPost } from '../testing/seed-az.ts';
import { declareAge } from '../testing/seed-b1.ts';
import { seedFeedPost } from '../testing/seed-c1.ts';
import { seedPerson } from '../testing/seed-f.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { readActivity, readProfile, type ProfileItem } from './read.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const viewer = await seedPerson(local, 'viewer');
  const mod = await seedPerson(local, 'mod');
  const admin = await seedPerson(local, 'boss', { admin: true });
  const alice = await seedPerson(local, 'Alice');
  const remote = await seedActor(lemmy, 'Person', 'rem', { summaryHtml: '<p>hello</p>', fetchedAt: new Date('2026-11-08T00:00:00Z') });
  const news = await seedActor(local, 'Group', 'news');
  const adult = await seedActor(local, 'Group', 'adult', { sensitive: true });
  const as = (person: { id: string }) => ({ actorId: person.id, siteRole: 'user' as const });
  return { local, lemmy, viewer, mod, admin, alice, remote, news, adult, as };
}

const titleOf = (item: ProfileItem) => (item.kind === 'post' ? item.post.title : item.comment.post.title + '/' + item.comment.view.id);

describe('readProfile', () => {
  test('a local person: handle in any case, bio, counts, badges, no home', async () => {
    const w = await world();
    await writer().update(actors).set({ summaryMd: 'I **write**', displayName: 'Alice A' }).where(eq(actors.id, w.alice.id));
    await seedModerator(w.news, w.alice);
    const post = await seedPost(w.local, w.news, w.alice);
    await seedComment(w.local, post, w.alice);
    await seedPost(w.local, w.news, w.alice, { deletedAt: new Date() });

    const profile = await readProfile('alice', w.as(w.viewer));
    expect(profile).toMatchObject({
      actor: { handle: 'Alice', displayName: 'Alice A', kind: 'Person', local: true },
      bio: { kind: 'markdown', source: 'I **write**' },
      counts: { posts: 1, comments: 1 },
      badges: { admin: false, moderator: true, bot: false, you: false },
      home: null,
      state: 'live',
      blocked: null,
      moderatedCommunities: [],
      indexable: true,
    });
    expect(await readProfile('@alice@feddit.test', null)).toMatchObject({ actor: { id: w.alice.id } });
    expect((await readProfile('Alice', w.as(w.alice)))?.badges.you).toBe(true);
  });

  test('the person and the moderated communities carry only the public reference fields', async () => {
    const w = await world();
    await seedModerator(w.news, w.viewer);
    await seedPost(w.local, w.news, w.admin);
    const profile = await readProfile('boss', w.as(w.viewer));
    const publicKeys = ['apId', 'displayName', 'handle', 'id', 'kind', 'local', 'name'];
    expect(Object.keys(profile!.actor).sort()).toEqual(publicKeys);
    expect(profile!.moderatedCommunities.map((ref) => Object.keys(ref).sort())).toEqual([publicKeys]);
    // Nothing of the account (user id, role, two-factor) or the stored row (raw JSON, keys, timestamps) is in it.
    expect(JSON.stringify(profile)).not.toMatch(/userId|"role"|twoFactor|"raw"|createdAt|summaryMd/);
  });

  test('a remote person has a home and refresh time; the bio is HTML', async () => {
    const w = await world();
    const profile = await readProfile('rem@lemmy.test', null);
    expect(profile).toMatchObject({
      actor: { handle: 'rem@lemmy.test', local: false },
      bio: { kind: 'html', html: '<p>hello</p>' },
      home: { host: 'lemmy.test', refreshedAt: '2026-11-08T00:00:00.000Z' },
    });
    expect(await readProfile('rem', null)).toBeNull();
    expect(w.remote.id).toBeTruthy();
  });

  test('admin badge needs two-factor; a bot is a Service', async () => {
    const w = await world();
    expect((await readProfile('boss', null))?.badges.admin).toBe(true);
    const lazy = await seedPerson(w.local, 'lazy', { admin: true, twoFactor: false });
    expect((await readProfile(lazy.name, null))?.badges.admin).toBe(false);
    await seedActor(w.lemmy, 'Service', 'helper');
    expect((await readProfile('helper@lemmy.test', null))?.badges.bot).toBe(true);
  });

  test('communities, the instance actor and unknown or malformed handles are not profiles', async () => {
    const w = await world();
    await seedActor(w.local, 'Application', 'feddit.test');
    for (const handle of ['news', 'feddit.test', 'nobody', '', 'a b', 'x@y@z', 'alice@'])
      expect(await readProfile(handle, null), handle).toBeNull();
  });

  test('a deleted account is returned without its text', async () => {
    const w = await world();
    await writer()
      .update(actors)
      .set({ deletedAt: new Date(), summaryMd: 'secret', iconUrl: 'https://x.test/a.png' })
      .where(eq(actors.id, w.alice.id));
    await seedPost(w.local, w.news, w.alice);
    expect(await readProfile('Alice', null)).toMatchObject({
      state: 'deleted',
      bio: null,
      iconUrl: null,
      counts: { posts: 0, comments: 0 },
      moderatedCommunities: [],
    });
  });

  test('blocked: directly or by instance, for the blocker only', async () => {
    const w = await world();
    await seedBlock(w.viewer, w.alice);
    await seedBlock(w.viewer, { instance: w.lemmy });
    expect((await readProfile('Alice', w.as(w.viewer)))?.blocked).toBe('actor');
    expect((await readProfile('rem@lemmy.test', w.as(w.viewer)))?.blocked).toBe('instance');
    expect((await readProfile('Alice', w.as(w.mod)))?.blocked).toBeNull();
    expect((await readProfile('Alice', null))?.blocked).toBeNull();
  });

  test('moderated communities: the viewer moderates and the person has live content, at most five', async () => {
    const w = await world();
    const communities = [];
    for (let n = 0; n < 7; n++) {
      const c = await seedActor(w.local, 'Group', `c${n}`);
      communities.push(c);
      await seedModerator(c, w.mod);
      await seedPost(w.local, c, w.alice);
    }
    const quiet = await seedActor(w.local, 'Group', 'quiet');
    await seedModerator(quiet, w.mod);
    const other = await seedActor(w.local, 'Group', 'other');
    await seedPost(w.local, other, w.alice);
    const profile = await readProfile('Alice', w.as(w.mod));
    expect(profile?.moderatedCommunities.map((c) => c.name)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect((await readProfile('Alice', w.as(w.viewer)))?.moderatedCommunities).toEqual([]);
    expect((await readProfile('Alice', null))?.moderatedCommunities).toEqual([]);
  });
});

describe('readActivity', () => {
  test('tabs: posts, comments, and both merged newest first', async () => {
    const w = await world();
    const p1 = await seedFeedPost(w.local, w.news, w.alice, { ago: 5_000, title: 'p1' });
    await seedComment(w.local, p1, w.alice, { publishedAt: new Date(Date.now() - 4_000), bodyMd: 'c1' });
    await seedFeedPost(w.local, w.news, w.alice, { ago: 3_000, title: 'p2' });
    const other = await seedFeedPost(w.local, w.news, w.viewer, { ago: 9_000, title: 'not hers' });
    await seedComment(w.local, other, w.alice, { publishedAt: new Date(Date.now() - 2_000), bodyMd: 'c2' });
    await seedComment(w.local, other, w.viewer, { bodyMd: 'not hers' });
    await seedComment(w.local, other, w.alice, { bodyMd: 'gone', deletedAt: new Date() });
    const read = async (tab: 'overview' | 'posts' | 'comments') =>
      (await readActivity({ personId: w.alice.id, tab, sort: 'new' }, null)).items;

    expect((await read('posts')).map(titleOf)).toEqual(['p2', 'p1']);
    const comments = await read('comments');
    expect(comments.map((i) => (i.kind === 'comment' ? i.comment.body : null))).toEqual([
      { kind: 'markdown', source: 'c2' },
      { kind: 'markdown', source: 'c1' },
    ]);
    expect(comments[0]).toMatchObject({
      comment: { post: { title: 'not hers' }, community: { name: 'news' }, view: { author: { name: 'Alice' }, depth: 0 } },
    });
    expect((await read('overview')).map((i) => (i.kind === 'post' ? i.post.title : (i.comment.body as { source: string }).source))).toEqual(
      ['c2', 'p2', 'c1', 'p1'],
    );
  });

  test('paging walks every item once, by date and by score, in each tab', async () => {
    const w = await world();
    const posts = [];
    for (let n = 0; n < 7; n++)
      posts.push(await seedFeedPost(w.local, w.news, w.alice, { ago: (n + 1) * 1_000, up: n % 3, title: `p${n}` }));
    for (let n = 0; n < 6; n++)
      await seedComment(w.local, posts[0]!, w.alice, { publishedAt: new Date(Date.now() - 500 - n * 700), upvotes: n % 4 });
    for (const sort of ['new', 'top'] as const)
      for (const [tab, expected] of [
        ['overview', 13],
        ['posts', 7],
        ['comments', 6],
      ] as const) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let pages = 0; pages < 20; pages++) {
          const page = await readActivity({ personId: w.alice.id, tab, sort, cursor, limit: 4 }, null);
          seen.push(...page.items.map((i) => (i.kind === 'post' ? i.post.id : i.comment.view.id)));
          if (!page.next) break;
          cursor = page.next;
        }
        expect(new Set(seen).size, `${sort} ${tab}`).toBe(expected);
        expect(seen, `${sort} ${tab}`).toHaveLength(expected);
      }
  });

  test('Top orders by score', async () => {
    const w = await world();
    await seedFeedPost(w.local, w.news, w.alice, { up: 1, title: 'low' });
    await seedFeedPost(w.local, w.news, w.alice, { up: 5, title: 'high' });
    expect((await readActivity({ personId: w.alice.id, tab: 'posts', sort: 'top' }, null)).items.map(titleOf)).toEqual(['high', 'low']);
  });

  test('removed, deleted and removed-community content is left out', async () => {
    const w = await world();
    await seedFeedPost(w.local, w.news, w.alice, { title: 'shown' });
    await seedFeedPost(w.local, w.news, w.alice, { title: 'removed', removedAt: new Date() });
    await seedFeedPost(w.local, w.news, w.alice, { title: 'deleted', deletedAt: new Date() });
    const gone = await seedActor(w.local, 'Group', 'gone', { deletedAt: new Date() });
    await seedFeedPost(w.local, gone, w.alice, { title: 'in a deleted community' });
    expect((await readActivity({ personId: w.alice.id, tab: 'posts', sort: 'new' }, null)).items.map(titleOf)).toEqual(['shown']);
  });

  test('the NSFW gate applies to posts and to comments on them', async () => {
    const w = await world();
    const gated = await seedFeedPost(w.local, w.adult, w.alice, { title: 'gated' });
    await seedComment(w.local, gated, w.alice, { bodyMd: 'on gated' });
    await seedFeedPost(w.local, w.news, w.alice, { title: 'plain' });
    await declareAge(w.viewer);
    const titles = async (viewer: { id: string } | null) =>
      (await readActivity({ personId: w.alice.id, tab: 'overview', sort: 'new' }, viewer && w.as(viewer))).items.length;
    expect(await titles(null)).toBe(1);
    expect(await titles(w.mod)).toBe(1);
    expect(await titles(w.viewer)).toBe(2);
  });

  test('Hide NSFW keeps a declared viewer from comments under a flagged post or community, unless this browser shows it', async () => {
    const w = await world();
    const inAdult = await seedFeedPost(w.local, w.adult, w.alice, { title: 'in adult' });
    const flagged = await seedFeedPost(w.local, w.news, w.alice, { title: 'flagged', nsfl: true });
    const plain = await seedFeedPost(w.local, w.news, w.alice, { title: 'plain' });
    await seedComment(w.local, inAdult, w.alice, { bodyMd: 'in adult' });
    await seedComment(w.local, flagged, w.alice, { bodyMd: 'flagged' });
    await seedComment(w.local, plain, w.alice, { bodyMd: 'plain' });
    await declareAge(w.viewer);
    const shown = async (nsfw?: NsfwChoice) =>
      (await readActivity({ personId: w.alice.id, tab: 'comments', sort: 'new', ...(nsfw && { nsfw }) }, w.as(w.viewer))).items.map(
        (item) => (item.kind === 'comment' ? item.comment.post.title : item.post.title),
      );
    expect(await shown()).toEqual(['plain']);
    expect(await shown(hideNsfw)).toEqual(['plain']);
    expect(await shown({ always: false, once: [w.adult.id] })).toEqual(['plain', 'in adult']);
    expect(await shown({ always: false, once: [w.news.id] })).toEqual(['plain', 'flagged']);
    expect(await shown(showNsfw)).toEqual(['plain', 'flagged', 'in adult']);
  });

  test("a blocked person's activity is hidden from the blocker only", async () => {
    const w = await world();
    const post = await seedFeedPost(w.local, w.news, w.alice, { title: 'hers' });
    await seedComment(w.local, post, w.alice);
    const count = async (viewer: { id: string }) =>
      (await readActivity({ personId: w.alice.id, tab: 'overview', sort: 'new' }, w.as(viewer))).items.length;
    await seedBlock(w.viewer, w.alice);
    expect(await count(w.viewer)).toBe(0);
    expect(await count(w.mod)).toBe(2);
  });

  test("comment votes are the viewer's own", async () => {
    const w = await world();
    const post = await seedFeedPost(w.local, w.news, w.alice);
    const comment = await seedComment(w.local, post, w.alice);
    const page = await readActivity({ personId: w.alice.id, tab: 'comments', sort: 'new' }, w.as(w.viewer));
    expect(page.items[0]).toMatchObject({ comment: { view: { id: comment.id, myVote: 0 } } });
  });
});
