import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';
import { comments } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { removeContent } from '../moderation/remove.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor } from '../testing/seed-az.ts';
import { seedPostWorld } from '../testing/seed-b1.ts';
import { seedChain, seedReply, seedTree } from '../testing/seed-d.ts';
import { localUser } from '../testing/seed.ts';
import { castVote } from '../votes/cast.ts';
import { threadDisplayDepth, threadMaxComments, threadPageSize, threadReplyPreview } from './limits.ts';
import { readThread, type Thread } from './read.ts';
import { threadSorts, type ThreadSort } from './sort.ts';

beforeEach(truncateAll);

async function world() {
  const w = await seedPostWorld();
  const post = { id: w.posts.local.normal };
  const viewer = (person: { id: string }, siteRole: 'user' | 'admin' = 'user') => ({ actorId: person.id, siteRole });
  return { w, post, viewer, at: w.instances.local };
}

const ids = (thread: Thread | null) => (thread?.comments ?? []).map(({ view }) => view.id);

describe('readThread', () => {
  test('is a flat list in display order, each comment followed by its replies, with depth and parentId', async () => {
    const { w, post, at } = await world();
    const old = new Date('2026-11-01T00:00:00Z');
    const later = (days: number) => ({ publishedAt: new Date(old.getTime() + days * 86_400_000) });
    const a = await seedReply(at, post, null, w.people.reader, { upvotes: 5, ...later(0) });
    const b = await seedReply(at, post, null, w.people.reader, { upvotes: 9, ...later(1) });
    const a1 = await seedReply(at, post, a, w.people.author, { upvotes: 1, ...later(2) });
    const a2 = await seedReply(at, post, a, w.people.author, { upvotes: 3, ...later(3) });
    const a2x = await seedReply(at, post, a2, w.people.reader, later(4));
    const now = new Date('2026-11-10T00:00:00Z');
    const read = async (sort: 'hot' | 'top' | 'new' | 'old') => readThread(post.id, null, { sort, now });

    const top = await read('top');
    expect(ids(top)).toEqual([b.id, a.id, a2.id, a2x.id, a1.id]);
    expect(top?.comments.map(({ view }) => [view.depth, view.parentId])).toEqual([
      [0, null],
      [0, null],
      [1, a.id],
      [2, a2.id],
      [1, a.id],
    ]);
    // Each sort orders the siblings, and only them.
    expect(ids(await read('new'))).toEqual([b.id, a.id, a2.id, a2x.id, a1.id]);
    expect(ids(await read('old'))).toEqual([a.id, a1.id, a2.id, a2x.id, b.id]);
    expect(ids(await read('hot'))).toHaveLength(5);
    // counts.comments is every comment below, however deep; the post's own page count sees all five.
    expect(top?.comments.map(({ view }) => view.counts.comments)).toEqual([0, 3, 1, 0, 0]);
  });

  test('sends only the levels the component draws, and the last level says how many replies it holds back', async () => {
    const { w, post, at } = await world();
    const chain = await seedChain(at, post, w.people.reader, 10);
    const thread = await readThread(post.id, null);
    expect(ids(thread)).toEqual(chain.slice(0, threadDisplayDepth).map(({ id }) => id));
    expect(thread?.comments.at(-1)?.view).toMatchObject({ depth: threadDisplayDepth - 1, counts: { comments: 10 - threadDisplayDepth } });
    expect(thread?.next).toBeNull();
  });

  test('a permalink page starts at its comment and shows the same number of levels below it', async () => {
    const { w, post, at } = await world();
    const chain = await seedChain(at, post, w.people.reader, 12);
    const sibling = await seedReply(at, post, null, w.people.author);
    const root = chain[3]!;
    const thread = await readThread(post.id, null, { rootId: root.id });
    expect(ids(thread)).toEqual(chain.slice(3, 3 + threadDisplayDepth).map(({ id }) => id));
    expect(thread?.focus).toEqual({ id: root.id, parentId: chain[2]!.id });
    expect(thread?.comments[0]?.view.depth).toBe(3);
    expect(thread?.comments.at(-1)?.view.counts.comments).toBe(12 - 3 - threadDisplayDepth);
    expect(ids(thread)).not.toContain(sibling.id);
  });

  test('is null for a missing post, and for a comment of another post', async () => {
    const { w, post, at } = await world();
    const elsewhere = await seedReply(at, { id: w.posts.local.locked }, null, w.people.reader);
    expect(await readThread('0192f5a0-1234-7abc-8def-0123456789ab', null)).toBeNull();
    expect(await readThread(post.id, null, { rootId: elsewhere.id })).toBeNull();
    expect(await readThread(post.id, null, { rootId: '0192f5a0-1234-7abc-8def-0123456789ab' })).toBeNull();
  });

  describe('what a viewer is shown', () => {
    async function states() {
      const ctx = await world();
      const { w, post, at } = ctx;
      const live = await seedReply(at, post, null, w.people.reader, { bodyMd: 'Live words' });
      const deleted = await seedReply(at, post, null, w.people.reader, { bodyMd: 'Deleted words', deletedAt: new Date() });
      const removed = await seedReply(at, post, null, w.people.reader, { bodyMd: 'Removed words' });
      const reply = await seedReply(at, post, removed, w.people.author, { bodyMd: 'Reply words' });
      const moderator = localUser(w.people.moderator.id);
      await removeContent(await grantFor('mod.remove', moderator, { target: { kind: 'comment', id: removed.id } }), {
        reason: 'Rule 3: no ads',
      });
      return { ...ctx, live, deleted, removed, reply };
    }
    const entry = (thread: Thread | null, id: string) => thread?.comments.find(({ view }) => view.id === id);

    test('a deleted comment is a tombstone and a removed one says only that; replies keep their place', async () => {
      const { post, live, deleted, removed, reply } = await states();
      const thread = await readThread(post.id, null, { sort: 'old' });
      expect(entry(thread, live.id)).toMatchObject({
        view: { deleted: false, removed: false },
        body: { kind: 'markdown', source: 'Live words' },
        removal: null,
      });
      expect(entry(thread, deleted.id)).toMatchObject({ view: { deleted: true, removed: false }, body: null, removal: null });
      expect(entry(thread, removed.id)).toMatchObject({ view: { deleted: false, removed: true }, body: null, removal: null });
      expect(entry(thread, reply.id)).toMatchObject({ view: { parentId: removed.id }, body: { source: 'Reply words' } });
      // Nothing of the withheld text is anywhere in what is handed to the page.
      expect(JSON.stringify(thread)).not.toContain('Deleted words');
      expect(JSON.stringify(thread)).not.toContain('Removed words');
    });

    test("a moderator, the community's owner and a site admin also get the modlog reason; nobody else does", async () => {
      const { w, post, viewer, removed } = await states();
      const reason = (who: Parameters<typeof readThread>[1]) =>
        readThread(post.id, who).then((thread) => entry(thread, removed.id)?.removal);
      expect(await reason(viewer(w.people.moderator))).toEqual({ reason: 'Rule 3: no ads' });
      expect(await reason(viewer(w.people.owner))).toEqual({ reason: 'Rule 3: no ads' });
      expect(await reason(viewer(w.people.admin, 'admin'))).toEqual({ reason: 'Rule 3: no ads' });
      for (const who of [null, viewer(w.people.reader), viewer(w.people.author)]) expect(await reason(who)).toBeNull();
      expect((await readThread(post.id, viewer(w.people.moderator)))?.moderator).toBe(true);
      expect((await readThread(post.id, viewer(w.people.reader)))?.moderator).toBe(false);
    });
  });

  test("a comment that is both deleted and removed is a removed one, with a moderator's removal note and no text", async () => {
    const { w, post, viewer, at } = await world();
    const both = await seedReply(at, post, null, w.people.reader, { bodyMd: 'Both words', deletedAt: new Date(), removedAt: new Date() });
    const asModerator = await readThread(post.id, viewer(w.people.moderator));
    expect(asModerator?.comments[0]).toMatchObject({
      view: { id: both.id, deleted: true, removed: true },
      body: null,
      removal: { reason: null },
    });
    expect(JSON.stringify(await readThread(post.id, null))).not.toContain('Both words');
  });

  test("shows the viewer's own votes, the author's badge and the handle of a remote author", async () => {
    const { w, post, viewer, at } = await world();
    const mine = await seedReply(at, post, null, w.people.reader);
    const byModerator = await seedReply(at, post, null, w.people.moderator);
    const byAdmin = await seedReply(at, post, null, w.people.admin);
    const byRemote = await seedReply(at, post, null, w.people.remoteAuthor);
    await castVote(await grantFor('vote.cast', localUser(w.people.reader.id), { target: { kind: 'comment', id: mine.id } }), { value: -1 });
    const thread = await readThread(post.id, viewer(w.people.reader), { sort: 'old' });
    const view = (id: string) => thread?.comments.find((entry) => entry.view.id === id)?.view;
    expect(view(mine.id)).toMatchObject({ myVote: -1, counts: { upvotes: 0, downvotes: 1 }, authorBadge: null });
    expect(view(byModerator.id)?.authorBadge).toBe('moderator');
    expect(view(byAdmin.id)?.authorBadge).toBe('admin');
    expect(view(byRemote.id)?.author).toMatchObject({ handle: 'remote_author@lemmy.test', local: false });
    expect(view(byRemote.id)?.myVote).toBe(0);
    // Signed out: nobody's vote is yours.
    expect((await readThread(post.id, null))?.comments.every(({ view: v }) => v.myVote === 0)).toBe(true);
  });

  test('an admin without two-factor gets no badge', async () => {
    const { w, post, at } = await world();
    const [admin] = await writer().select({ userId: actors.userId }).from(actors).where(eq(actors.id, w.people.admin.id));
    await writer().update(authUser).set({ twoFactorEnabled: false }).where(eq(authUser.id, admin!.userId!));
    await seedReply(at, post, null, w.people.admin);
    expect((await readThread(post.id, null))?.comments[0]?.view.authorBadge).toBeNull();
  });

  test('a remote comment with only HTML comes back as html with its own url as the base', async () => {
    const { w, post, at } = await world();
    const remote = await seedReply(at, post, null, w.people.remoteAuthor, { bodyMd: null, contentHtml: '<p>From a peer</p>' });
    const row = (await writer().select().from(comments).where(eq(comments.id, remote.id)))[0]!;
    const thread = await readThread(post.id, null);
    expect(thread?.comments[0]?.body).toEqual({ kind: 'html', html: '<p>From a peer</p>', baseUrl: row.apId });
  });
});

// The order of siblings is SQL, so a page of them is chosen in the sort's order before the limit.
describe('the order of siblings', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  test.each([
    // A fresh comment with a fair score, an old one with a great score, and a brand new one with none.
    ['hot', ['fresh-fair', 'new-none', 'old-great']],
    ['top', ['old-great', 'fresh-fair', 'new-none']],
    ['new', ['new-none', 'fresh-fair', 'old-great']],
    ['old', ['old-great', 'fresh-fair', 'new-none']],
  ] as const)('%s', async (sort, expected) => {
    const { w, post, at } = await world();
    const made = {
      'old-great': await seedReply(at, post, null, w.people.reader, { upvotes: 100, publishedAt: hoursAgo(48) }),
      'fresh-fair': await seedReply(at, post, null, w.people.reader, { upvotes: 10, publishedAt: hoursAgo(1) }),
      'new-none': await seedReply(at, post, null, w.people.reader, { publishedAt: hoursAgo(0) }),
    };
    const thread = await readThread(post.id, null, { sort, now });
    expect(ids(thread)).toEqual(expected.map((name) => made[name].id));
  });

  test('hot is the score over the age, as Lemmy ranks it, and a score below -2 ranks as -2', async () => {
    const { w, post, at } = await world();
    const rank = (up: number, down: number, hours: number) => Math.log10(Math.max(1, up - down + 3)) / (Math.max(0, hours) + 2) ** 1.8;
    const specs = [
      { up: 40, down: 2, hours: 30 },
      { up: 3, down: 0, hours: 0.5 },
      { up: 0, down: 50, hours: 1 },
      { up: 0, down: 4, hours: 2 },
      { up: 12, down: 12, hours: 3 },
      { up: 90, down: 10, hours: 400 },
    ];
    const made = await Promise.all(
      specs.map((spec) =>
        seedReply(at, post, null, w.people.reader, { upvotes: spec.up, downvotes: spec.down, publishedAt: hoursAgo(spec.hours) }),
      ),
    );
    const expected = made
      .map((row, index) => ({ id: row.id, rank: rank(specs[index]!.up, specs[index]!.down, specs[index]!.hours) }))
      .sort((a, b) => b.rank - a.rank)
      .map(({ id }) => id);
    expect(ids(await readThread(post.id, null, { sort: 'hot', now }))).toEqual(expected);
  });

  test('comments with the same score and time keep one order, by id', async () => {
    const { w, post, at } = await world();
    const same = { upvotes: 5, publishedAt: hoursAgo(3) };
    const a = await seedReply(at, post, null, w.people.reader, same);
    const b = await seedReply(at, post, null, w.people.reader, same);
    const [low, high] = [a.id, b.id].sort();
    for (const sort of ['hot', 'top', 'new'] as const) expect(ids(await readThread(post.id, null, { sort, now }))).toEqual([high, low]);
    expect(ids(await readThread(post.id, null, { sort: 'old', now }))).toEqual([low, high]);
  });
});

describe('pages of siblings', () => {
  const total = threadPageSize + 7;

  /** The ids of the siblings each page lists, walking `next` (each page asked a day later than the one before, as a slow reader would). */
  async function walk(postId: string, sort: ThreadSort, rootId: string | null = null) {
    const pages: string[][] = [];
    let after: string | null = null;
    for (let at = Date.now(); pages.length < 10; at += 86_400_000) {
      const thread: Thread | null = await readThread(postId, null, { sort, rootId, after, now: new Date(at) });
      pages.push(thread!.comments.filter(({ view }) => view.parentId === rootId).map(({ view }) => view.id));
      after = thread!.next;
      if (!after) break;
    }
    return pages;
  }

  test.each(threadSorts)('%s: a page is the next siblings in the sort order, and no sibling is repeated or skipped', async (sort) => {
    const { w, post, at } = await world();
    await seedTree(at, post, [w.people.reader, w.people.author], [total]);
    const pages = await walk(post.id, sort);
    expect(pages.map((page) => page.length)).toEqual([threadPageSize, total - threadPageSize]);
    expect(new Set(pages.flat()).size).toBe(total);
    // Hot's order has its own test; the others are plain comparisons over all the siblings.
    type Stored = { id: string; upvotes: number; downvotes: number; publishedAt: Date };
    const newest = (a: Stored, b: Stored) => b.publishedAt.getTime() - a.publishedAt.getTime() || (a.id < b.id ? 1 : -1);
    const compare: Partial<Record<ThreadSort, (a: Stored, b: Stored) => number>> = {
      top: (a, b) => b.upvotes - b.downvotes - (a.upvotes - a.downvotes) || newest(a, b),
      new: newest,
      old: (a, b) => -newest(a, b),
    };
    const order = compare[sort];
    if (order) {
      const rows = await writer().select().from(comments).where(eq(comments.postId, post.id));
      expect(pages.flat()).toEqual(rows.sort(order).map(({ id }) => id));
    }
  });

  test('the first page holds the best siblings of the whole set, not of the first rows stored', async () => {
    const { w, post, at } = await world();
    // The best scored comments are the last ones stored (the path order a global limit would cut).
    for (let index = 0; index < total; index++) await seedReply(at, post, null, w.people.reader, { upvotes: index });
    const thread = await readThread(post.id, null, { sort: 'top' });
    expect(thread?.comments).toHaveLength(threadPageSize);
    expect(thread?.comments.map(({ view }) => view.counts.upvotes)).toEqual(
      Array.from({ length: threadPageSize }, (_, index) => total - 1 - index),
    );
    expect(thread?.next).toEqual(expect.any(String));
  });

  test('a cursor from another sort, another set of siblings or no cursor at all starts at the first page', async () => {
    const { w, post, at } = await world();
    const [first] = await seedTree(at, post, [w.people.reader], [total, 1]);
    const top = await readThread(post.id, null, { sort: 'top' });
    const second = await readThread(post.id, null, { sort: 'top', after: top!.next });
    expect(second?.comments.filter(({ view }) => view.parentId === null)).toHaveLength(total - threadPageSize);
    for (const [sort, rootId, after] of [
      ['new', null, top!.next],
      ['top', first!.id, top!.next],
      ['top', null, 'not a cursor'],
      ['top', null, Buffer.from('{"v":1}').toString('base64url')],
      ['top', null, 'x'.repeat(500)],
    ] as const) {
      const thread = await readThread(post.id, null, { sort, rootId, after });
      expect(thread?.comments.filter(({ view }) => view.parentId === rootId)).toHaveLength(rootId ? 1 : threadPageSize);
    }
  });

  test('the replies under a permalink comment page the same way, with the comment itself on every page', async () => {
    const { w, post, at } = await world();
    const [parent] = await seedTree(at, post, [w.people.reader], [1, total]);
    const root = parent!.id;
    const pages = await walk(post.id, 'new', root);
    expect(pages.map((page) => page.length)).toEqual([threadPageSize, total - threadPageSize]);
    const later = await readThread(post.id, null, {
      sort: 'new',
      rootId: root,
      after: (await readThread(post.id, null, { sort: 'new', rootId: root }))?.next,
    });
    expect(later?.comments[0]?.view.id).toBe(root);
    expect(later?.focus?.id).toBe(root);
  });

  test('a comment lists its first few replies, and counts.comments says how many the page left out', async () => {
    const { w, post, at } = await world();
    const parent = await seedReply(at, post, null, w.people.reader);
    for (let index = 0; index < threadReplyPreview + 4; index++) await seedReply(at, post, parent, w.people.author, { upvotes: index });
    const thread = await readThread(post.id, null, { sort: 'top' });
    expect(thread?.comments).toHaveLength(1 + threadReplyPreview);
    // The best scored replies are the ones listed.
    expect(thread?.comments.slice(1).map(({ view }) => view.counts.upvotes)).toEqual(
      Array.from({ length: threadReplyPreview }, (_, index) => threadReplyPreview + 3 - index),
    );
    expect(thread?.comments[0]?.view.counts.comments).toBe(threadReplyPreview + 4);
    expect(thread?.next).toBeNull();
  });
});

describe('a page of a big thread', () => {
  test('sends at most 300 comments, the top of the thread first, and every comment is reachable through next and the comments cut', async () => {
    const { w, post, at } = await world();
    // 28 top-level comments with 6 replies each with 6 replies each: 1,204 in all.
    const made = await seedTree(at, post, [w.people.reader, w.people.author], [threadPageSize + 3, 6, 6]);
    const first = await readThread(post.id, null, { sort: 'new' });
    expect(first?.comments.length).toBeLessThanOrEqual(threadMaxComments);
    expect(first?.comments.length).toBeGreaterThan(threadPageSize);
    // Level by level: every top-level comment of the page is there before any third level.
    expect(first?.comments.filter(({ view }) => view.depth === 0)).toHaveLength(threadPageSize);
    expect(first?.comments.filter(({ view }) => view.depth === 1).length).toBeGreaterThan(threadPageSize);

    const seen = new Set<string>();
    const visited = new Set<string | null>();
    const queue: (string | null)[] = [null];
    for (let root = queue.shift(); root !== undefined; root = queue.shift()) {
      if (visited.has(root)) continue;
      visited.add(root);
      for (let after: string | null = null, pages = 0; pages === 0 || after; pages++) {
        const thread: Thread | null = await readThread(post.id, null, { sort: 'new', rootId: root, after });
        expect(thread!.comments.length).toBeLessThanOrEqual(threadMaxComments);
        const below = (id: string): number => {
          const kids = thread!.comments.filter(({ view }) => view.parentId === id);
          return kids.length + kids.reduce((sum, { view }) => sum + below(view.id), 0);
        };
        for (const { view } of thread!.comments) {
          seen.add(view.id);
          // A comment whose replies the page left out is where the reader continues.
          if (view.id !== root && view.counts.comments > below(view.id)) queue.push(view.id);
        }
        after = thread!.next;
      }
    }
    expect(seen.size).toBe(made.length);
  }, 60_000);
});
