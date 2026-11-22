import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { communityBlocks, instanceBlocks, personBlocks } from '../blocks/tables.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { refusedAsResult } from '../identity/result.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { peerControls } from '../peers/tables.ts';
import { readPost } from '../posts/read.ts';
import { truncateAll } from '../testing/db.ts';
import { outboxEvents, seedCommunityRemoval, seedPost } from '../testing/seed-az.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { person, seedPerson } from '../testing/seed-f.ts';
import { addSave } from './mutations.ts';
import { readSaved } from './read.ts';
import { savedAmong, savePostAs, unsavePostAs } from './saves.ts';
import { savedPosts } from './tables.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const ann = await seedPerson(local, 'ann');
  const ben = await seedPerson(local, 'ben');
  const cat = await seedActor(local, 'Person', 'cat');
  const news = await seedActor(local, 'Group', 'news');
  const tech = await seedActor(lemmy, 'Group', 'tech');
  const remoteDan = await seedActor(lemmy, 'Person', 'dan');
  await writer().insert(ageDeclarations).values({ actorId: ann.id });
  return { local, lemmy, ann, ben, cat, news, tech, remoteDan, viewer: { actorId: ann.id, siteRole: 'user' as const } };
}

const saveEvents = async () => (await outboxEvents()).filter((event) => (event as { type: string }).type.startsWith('save.'));
const rowsOf = (ownerId: string) => db().select().from(savedPosts).where(eq(savedPosts.ownerId, ownerId));
const savedIds = async (viewer: { actorId: string; siteRole: 'user' }) => (await readSaved(viewer)).items.map(({ id }) => id);

describe('save.add and save.remove', () => {
  test('saving is idempotent: one row and one event, and unsaving twice emits once', async () => {
    const w = await world();
    const post = await seedPost(w.local, w.news, w.cat);
    const me = person(w.ann.id);

    expect(await savePostAs(me, { postId: post.id })).toEqual({ ok: true, saved: true });
    expect(await savePostAs(me, { postId: post.id })).toEqual({ ok: true, saved: true });
    expect(await rowsOf(w.ann.id)).toHaveLength(1);
    expect(await saveEvents()).toEqual([{ type: 'save.added', v: 1, ownerId: w.ann.id, postId: post.id }]);

    expect(await unsavePostAs(me, { postId: post.id })).toEqual({ ok: true, saved: false });
    expect(await unsavePostAs(me, { postId: post.id })).toEqual({ ok: true, saved: false });
    expect(await rowsOf(w.ann.id)).toHaveLength(0);
    expect((await saveEvents()).map((event) => (event as { type: string }).type)).toEqual(['save.added', 'save.removed']);
  });

  test('who may: a signed-in local person, and only a live post of an open community', async () => {
    const w = await world();
    const live = await seedPost(w.local, w.news, w.cat);
    const removed = await seedPost(w.local, w.news, w.cat, { removedAt: new Date() });
    const deleted = await seedPost(w.local, w.news, w.cat, { deletedAt: new Date() });
    const missing = '019aaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
    const me = person(w.ann.id);

    expect(await savePostAs({ kind: 'anonymous' }, { postId: live.id })).toEqual({ ok: false, reason: 'auth.required' });
    expect(await savePostAs({ kind: 'remote', actorId: w.remoteDan.id, announcedBy: null }, { postId: live.id })).toEqual({
      ok: false,
      reason: 'auth.required',
    });
    expect(await unsavePostAs({ kind: 'anonymous' }, { postId: live.id })).toEqual({ ok: false, reason: 'auth.required' });
    for (const postId of [removed.id, deleted.id, missing])
      expect(await savePostAs(me, { postId })).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await saveEvents()).toEqual([]);
  });

  test('a post removed after it was saved can still be unsaved', async () => {
    const w = await world();
    const post = await seedPost(w.local, w.news, w.cat);
    await savePostAs(person(w.ann.id), { postId: post.id });
    await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, post.id));
    expect(await unsavePostAs(person(w.ann.id), { postId: post.id })).toEqual({ ok: true, saved: false });
    expect(await rowsOf(w.ann.id)).toHaveLength(0);
  });

  test('a gated post is not found for someone without the 16+ declaration, then and inside the write; Unsave stays open', async () => {
    const w = await world();
    const dark = await seedActor(w.local, 'Group', 'dark', { sensitive: true });
    const gated = [
      await seedPost(w.local, w.news, w.cat, { sensitive: true }),
      await seedPost(w.local, w.news, w.cat, { nsfl: true }),
      await seedPost(w.local, dark, w.cat),
    ];
    const plain = await seedPost(w.local, w.news, w.cat);
    // Ben has not declared: the post page would show him the age gate, so a save answers as for a missing post.
    for (const { id } of gated)
      expect(await savePostAs(person(w.ben.id), { postId: id })).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await savePostAs(person(w.ben.id), { postId: plain.id })).toEqual({ ok: true, saved: true });
    // Ann has: she saves them as before.
    for (const { id } of gated) expect(await savePostAs(person(w.ann.id), { postId: id })).toEqual({ ok: true, saved: true });

    // Rechecked inside the transaction: a declaration gone between authorize() and the write refuses.
    const late = await seedPost(w.local, w.news, w.cat, { sensitive: true });
    const decision = await authorize('save.add', person(w.ann.id), { postId: late.id });
    expect(decision.ok).toBe(true);
    await writer().delete(ageDeclarations).where(eq(ageDeclarations.actorId, w.ann.id));
    if (decision.ok) expect(await refusedAsResult(() => addSave(decision.grant))).toEqual({ ok: false, reason: 'target.not_found' });
    // Unsave of a post she may no longer open still works by id.
    for (const { id } of gated) expect(await unsavePostAs(person(w.ann.id), { postId: id })).toEqual({ ok: true, saved: false });
    expect(await rowsOf(w.ann.id)).toEqual([]);
    expect((await saveEvents()).filter((event) => (event as { postId: string }).postId === late.id)).toEqual([]);
  });
});

describe('owner-only', () => {
  test('a second account cannot read or change the first account’s saves', async () => {
    const w = await world();
    const post = await seedPost(w.local, w.news, w.cat);
    await savePostAs(person(w.ann.id), { postId: post.id });
    const ben = { actorId: w.ben.id, siteRole: 'user' as const };

    // Reading: Ben's Saved page, Ben's post views and Ben's savedAmong know nothing of Ann's save.
    expect((await readSaved(ben)).items).toEqual([]);
    expect([...(await savedAmong(w.ben.id, [post.id]))]).toEqual([]);
    expect((await readPost(post.id, ben))?.view.saved).toBe(false);
    expect((await readPost(post.id, w.viewer))?.view.saved).toBe(true);
    expect([...(await savedAmong(null, [post.id]))]).toEqual([]);

    // Changing: Ben's unsave of the same post removes only Ben's (absent) row and emits nothing.
    expect(await unsavePostAs(person(w.ben.id), { postId: post.id })).toEqual({ ok: true, saved: false });
    expect(await rowsOf(w.ann.id)).toHaveLength(1);
    // Ben's own save is his row; Ann's first save stays as it was.
    const [before] = await rowsOf(w.ann.id);
    await savePostAs(person(w.ben.id), { postId: post.id });
    expect(await rowsOf(w.ann.id)).toEqual([before]);
    expect((await saveEvents()).map((event) => (event as { ownerId: string }).ownerId)).toEqual([w.ann.id, w.ben.id]);
  });
});

describe('the Saved page', () => {
  test('newest save first, cursor paged, nothing repeated or skipped; a bad cursor starts again', async () => {
    const w = await world();
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await seedPost(w.local, w.news, w.cat));
    const base = Date.now() - 60_000;
    // Two saves share one instant, so the post id breaks the tie.
    const times = [0, 1, 1, 2, 3].map((s) => new Date(base + s * 1000));
    for (const [i, post] of made.entries())
      await writer().insert(savedPosts).values({ ownerId: w.ann.id, postId: post.id, savedAt: times[i]! });

    const first = await readSaved(w.viewer, { limit: 2 });
    const second = await readSaved(w.viewer, { limit: 2, cursor: first.nextCursor! });
    const third = await readSaved(w.viewer, { limit: 2, cursor: second.nextCursor! });
    const order = [...made]
      .map((post, i) => ({ id: post.id, at: times[i]!.getTime() }))
      .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
      .map(({ id }) => id);
    expect([...first.items, ...second.items, ...third.items].map(({ id }) => id)).toEqual(order);
    expect(third.nextCursor).toBeNull();
    expect(first.items[0]).toMatchObject({ saved: true, savedAt: times[4]!.toISOString() });
    expect((await readSaved(w.viewer, { limit: 2, cursor: 'not-a-cursor' })).items.map(({ id }) => id)).toEqual(order.slice(0, 2));
  });

  test('a saved post that is later removed, deleted, closed, blocked or gated leaves the page', async () => {
    const w = await world();
    const blockedPerson = await seedActor(w.local, 'Person', 'blocked');
    const blockedCommunity = await seedActor(w.local, 'Group', 'blockedc');
    const closing = await seedActor(w.local, 'Group', 'closing');
    const removedCommunity = await seedActor(w.local, 'Group', 'gone');
    const shady = await seedInstance('shady.test', false);
    const shadyCommunity = await seedActor(shady, 'Group', 'shady');
    const peer = await seedInstance('peer.test', false);
    const peerCommunity = await seedActor(peer, 'Group', 'peer');

    const kept = await seedPost(w.local, w.news, w.cat);
    const remote = await seedPost(w.lemmy, w.tech, w.remoteDan);
    const sensitive = await seedPost(w.local, w.news, w.cat, { sensitive: true });
    const leaving = {
      removed: await seedPost(w.local, w.news, w.cat),
      deleted: await seedPost(w.local, w.news, w.cat),
      byBlockedPerson: await seedPost(w.local, w.news, blockedPerson),
      inBlockedCommunity: await seedPost(w.local, blockedCommunity, w.cat),
      onBlockedInstance: await seedPost(shady, shadyCommunity, w.cat),
      onBlockedPeer: await seedPost(peer, peerCommunity, w.cat),
      communityDeleted: await seedPost(w.local, closing, w.cat),
      communityRemoved: await seedPost(w.local, removedCommunity, w.cat),
    };
    for (const post of [kept, remote, sensitive, ...Object.values(leaving)])
      expect(await savePostAs(person(w.ann.id), { postId: post.id })).toMatchObject({ ok: true });
    expect(await savedIds(w.viewer)).toHaveLength(11);

    await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, leaving.removed.id));
    await writer().update(posts).set({ deletedAt: new Date() }).where(eq(posts.id, leaving.deleted.id));
    await writer().insert(personBlocks).values({ blockerId: w.ann.id, blockedId: blockedPerson.id });
    await writer().insert(communityBlocks).values({ blockerId: w.ann.id, communityId: blockedCommunity.id });
    await writer().insert(instanceBlocks).values({ blockerId: w.ann.id, instanceId: shady.id });
    await writer().insert(peerControls).values({ instanceId: peer.id, blocked: true });
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, closing.id));
    await seedCommunityRemoval(removedCommunity);

    const page = await readSaved(w.viewer);
    expect(new Set(page.items.map(({ id }) => id))).toEqual(new Set([kept.id, remote.id, sensitive.id]));
    // Nothing of a post that left is in what the page sends: no title, no snippet.
    const sent = JSON.stringify(page);
    for (const post of Object.values(leaving)) {
      expect(sent).not.toContain(post.id);
      expect(sent).not.toContain(post.title);
    }

    // Without the 16+ declaration the sensitive post leaves too (the feeds' age gate).
    await writer().delete(ageDeclarations).where(eq(ageDeclarations.actorId, w.ann.id));
    expect(new Set(await savedIds(w.viewer))).toEqual(new Set([kept.id, remote.id]));
    // The saves themselves stay: lifting a block brings its post back.
    await writer().delete(personBlocks).where(eq(personBlocks.blockerId, w.ann.id));
    expect(await savedIds(w.viewer)).toContain(leaving.byBlockedPerson.id);
  });

  test('a full page of saves that all left still ends the walk', async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) {
      const post = await seedPost(w.local, w.news, w.cat);
      await savePostAs(person(w.ann.id), { postId: post.id });
      await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, post.id));
    }
    expect(await readSaved(w.viewer, { limit: 2 })).toEqual({ items: [], nextCursor: null });
  });
});
