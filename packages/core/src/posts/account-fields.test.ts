import type { Uuid } from '@peblish/schema/ids';
import { beforeEach, describe, expect, test } from 'vitest';
import { readThread } from '../comments/read.ts';
import { follows } from '../db/tables/follows.ts';
import { writer } from '../db/write.ts';
import { sidebarCommunities } from '../feeds/shell.ts';
import { readActivity } from '../profiles/read.ts';
import { truncateAll } from '../testing/db.ts';
import { seedComment, seedModerator, seedPost } from '../testing/seed-az.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { postViews, readPost, type Viewer } from './read.ts';

// The fields branch 5's account features add to the existing views, as the readers return them
// while nothing is saved, pinned, followed or visited: the inert defaults, the follow state, and
// a permalink built from ids, which a viewer shown a tombstone does not get.

const past = () => new Date(Date.now() - 60_000);
const as = (actorId: Uuid): Viewer => ({ actorId, siteRole: 'user' });

async function world() {
  const here = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const alice = await seedActor(here, 'Person', 'alice');
  const bob = await seedActor(here, 'Person', 'bob');
  const mod = await seedActor(here, 'Person', 'mod');
  const news = await seedActor(here, 'Group', 'news');
  const tech = await seedActor(lemmy, 'Group', 'tech');
  await seedModerator(news, mod);
  const live = await seedPost(here, news, alice);
  const deleted = await seedPost(here, news, alice, { deletedAt: past() });
  const removed = await seedPost(here, news, alice, { removedAt: past() });
  const comments = {
    live: await seedComment(here, live, bob),
    deleted: await seedComment(here, live, bob, { deletedAt: past() }),
    removed: await seedComment(here, live, bob, { removedAt: past() }),
  };
  return { alice, bob, mod, news, tech, posts: { live, deleted, removed }, comments };
}

beforeEach(truncateAll);

describe('post views', () => {
  test('carry their permalink and are neither saved nor followed', async () => {
    const w = await world();
    const page = await readPost(w.posts.live.id, as(w.bob.id));
    expect(page?.view).toMatchObject({ permalink: `https://feddit.test/post/${w.posts.live.id}`, saved: false, watching: false });
    const [inFeed] = await postViews([w.posts.live], as(w.bob.id));
    expect(inFeed).toMatchObject({ permalink: page?.view.permalink, saved: false, watching: false });
    expect(page?.view.permalink).not.toContain(w.alice.name);
  });

  test('a tombstone, or a post removed for this reader, has no permalink; its moderator keeps it', async () => {
    const w = await world();
    for (const post of [w.posts.deleted, w.posts.removed]) {
      const view = (await readPost(post.id, as(w.bob.id)))?.view;
      expect(view && 'permalink' in view).toBe(false);
      expect(view).toMatchObject({ saved: false, watching: false });
    }
    expect((await readPost(w.posts.removed.id, as(w.mod.id)))?.view.permalink).toBe(`https://feddit.test/post/${w.posts.removed.id}`);
  });
});

describe('thread views', () => {
  test('a first visit: nothing is new, live comments carry their permalink, tombstones none', async () => {
    const w = await world();
    for (const viewer of [as(w.alice.id), as(w.mod.id), null]) {
      const thread = await readThread(w.posts.live.id, viewer);
      expect(thread).toMatchObject({ previousVisitAt: null, newCount: 0 });
      const byId = new Map(thread?.comments.map(({ view }) => [view.id, view]));
      expect(byId.get(w.comments.live.id)).toMatchObject({
        permalink: `https://feddit.test/post/${w.posts.live.id}/comments/${w.comments.live.id}`,
        isNew: false,
      });
      for (const gone of [w.comments.deleted, w.comments.removed]) {
        const view = byId.get(gone.id);
        expect(view && 'permalink' in view).toBe(false);
        expect(view?.isNew).toBe(false);
      }
    }
  });

  test("a profile's comments carry their permalink and are never new", async () => {
    const w = await world();
    const page = await readActivity({ personId: w.bob.id, tab: 'comments', sort: 'new' }, as(w.alice.id));
    expect(page.items).toEqual([
      expect.objectContaining({
        comment: expect.objectContaining({
          view: expect.objectContaining({
            id: w.comments.live.id,
            permalink: `https://feddit.test/post/${w.posts.live.id}/comments/${w.comments.live.id}`,
            isNew: false,
          }),
        }),
      }),
    ]);
  });
});

describe("the shell's communities", () => {
  test('carry the follow state and no pin', async () => {
    const w = await world();
    await writer()
      .insert(follows)
      .values([
        { followerId: w.alice.id, followeeId: w.news.id, apId: 'https://feddit.test/follow/1', state: 'accepted', acceptedAt: new Date() },
        { followerId: w.alice.id, followeeId: w.tech.id, apId: 'https://feddit.test/follow/2', state: 'pending' },
      ]);
    const mine = await sidebarCommunities(w.alice.id);
    expect(mine.local).toEqual([expect.objectContaining({ id: w.news.id, followState: 'accepted', pinned: false, pinPosition: null })]);
    expect(mine.remote).toEqual([expect.objectContaining({ id: w.tech.id, followState: 'pending', pinned: false, pinPosition: null })]);
    const visitor = await sidebarCommunities(null);
    expect(visitor.local).toEqual([expect.objectContaining({ id: w.news.id, followState: 'none', pinned: false, pinPosition: null })]);
  });
});
