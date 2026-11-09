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
import { recount, seedChain, seedReply } from '../testing/seed-d.ts';
import { localUser } from '../testing/seed.ts';
import { castVote } from '../votes/cast.ts';
import { readThread, threadDisplayDepth, threadMaxComments, type Thread } from './read.ts';

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
    await recount(post.id);
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
    expect(thread?.truncated).toBe(false);
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

  test('sends a page of comments, the first in display order, and says there are more', async () => {
    const { w, post, at } = await world();
    for (let index = 0; index < threadMaxComments + 5; index++) await seedReply(at, post, null, w.people.reader, { upvotes: index });
    const thread = await readThread(post.id, null, { sort: 'top' });
    expect(thread?.comments).toHaveLength(threadMaxComments);
    expect(thread?.truncated).toBe(true);
    // The best scored are the ones kept.
    expect(thread?.comments[0]?.view.counts.upvotes).toBe(threadMaxComments + 4);
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
