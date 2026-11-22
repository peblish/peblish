import type { Uuid } from '@peblish/schema/ids';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { instanceBlocks, personBlocks } from '../blocks/tables.ts';
import { readThread } from '../comments/read.ts';
import { db } from '../db/read.ts';
import { writer } from '../db/write.ts';
import type { Viewer } from '../posts/read.ts';
import { truncateAll } from '../testing/db.ts';
import { outboxEvents, seedComment, seedCommunityRemoval, seedPost } from '../testing/seed-az.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { threadVisits } from './tables.ts';
import { recordVisitAs, threadVisit } from './visits.ts';

// "New since last visit": the first visit is the baseline, a later one marks what arrived since,
// the markers hold for the whole visit, and a marker is its owner's alone. A later visit is made
// by moving the marker back in time, as an earlier visit would have left it.

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const as = (actorId: Uuid): Viewer => ({ actorId, siteRole: 'user' });
const visitEvents = async () => (await outboxEvents()).filter((event) => (event as { type: string }).type === 'visit.recorded');

async function world() {
  const here = await seedInstance('feddit.test');
  const elsewhere = await seedInstance('lemmy.test', false);
  const alice = await seedActor(here, 'Person', 'alice');
  const bob = await seedActor(here, 'Person', 'bob');
  const carol = await seedActor(here, 'Person', 'carol');
  const remote = await seedActor(elsewhere, 'Person', 'dan');
  const news = await seedActor(here, 'Group', 'news');
  const post = await seedPost(here, news, alice);
  return { here, alice, bob, carol, remote, news, post };
}

/** Leaves alice's marker as a visit `minutes` ago would have (the baseline, with nothing before it). */
async function visitedAgo(ownerId: Uuid, postId: Uuid, minutes: number) {
  await writer()
    .update(threadVisits)
    .set({ lastVisitAt: ago(minutes), previousVisitAt: null })
    .where(and(eq(threadVisits.ownerId, ownerId), eq(threadVisits.postId, postId)));
}

const markerOf = async (ownerId: Uuid, postId: Uuid) =>
  (
    await db()
      .select()
      .from(threadVisits)
      .where(and(eq(threadVisits.ownerId, ownerId), eq(threadVisits.postId, postId)))
  )[0];

const newIds = async (postId: Uuid, viewer: Viewer) => {
  const thread = await readThread(postId, viewer);
  return {
    count: thread?.newCount,
    previous: thread?.previousVisitAt,
    ids: thread?.comments.filter(({ view }) => view.isNew).map(({ view }) => view.id),
  };
};

beforeEach(truncateAll);

describe('a visit', () => {
  test('the first one sets the baseline: nothing is new, then or later in the same visit', async () => {
    const { here, alice, bob, post } = await world();
    await seedComment(here, post, bob, { createdAt: ago(60) });
    expect(await newIds(post.id, as(alice.id))).toEqual({ count: 0, previous: null, ids: [] });

    expect(await recordVisitAs(localUser(alice.id), { postId: post.id })).toEqual({ ok: true, recorded: true });
    await seedComment(here, post, bob);
    expect(await newIds(post.id, as(alice.id))).toEqual({ count: 0, previous: null, ids: [] });
    expect(await visitEvents()).toEqual([expect.objectContaining({ type: 'visit.recorded', v: 1, ownerId: alice.id, postId: post.id })]);
  });

  test('a later one marks what this server received since, by others, live and not blocked', async () => {
    const { here, alice, bob, carol, remote, post } = await world();
    await recordVisitAs(localUser(alice.id), { postId: post.id });
    await visitedAgo(alice.id, post.id, 120);
    await seedComment(here, post, bob, { createdAt: ago(180) });
    const fresh = await seedComment(here, post, bob, { createdAt: ago(60) });
    const reply = await seedComment(here, post, remote, { createdAt: ago(30) });
    await seedComment(here, post, alice, { createdAt: ago(50) });
    await seedComment(here, post, bob, { createdAt: ago(40), removedAt: ago(35) });
    await seedComment(here, post, bob, { createdAt: ago(40), deletedAt: ago(35) });
    await seedComment(here, post, carol, { createdAt: ago(40) });
    await writer().insert(personBlocks).values({ blockerId: alice.id, blockedId: carol.id });

    const seen = await newIds(post.id, as(alice.id));
    expect(seen.count).toBe(2);
    expect(new Set(seen.ids)).toEqual(new Set([fresh.id, reply.id]));
    expect(seen.previous && Math.abs(Date.parse(seen.previous) - ago(120).getTime())).toBeLessThan(5_000);

    // Blocking the remote author's instance takes their comment out of the count as well.
    await writer().insert(instanceBlocks).values({ blockerId: alice.id, instanceId: remote.instanceId });
    expect(await newIds(post.id, as(alice.id))).toMatchObject({ count: 1, ids: [fresh.id] });
  });

  test('recording it keeps the markers for the rest of the visit, and recording again within it writes nothing', async () => {
    const { here, alice, bob, post } = await world();
    await recordVisitAs(localUser(alice.id), { postId: post.id });
    await visitedAgo(alice.id, post.id, 120);
    const fresh = await seedComment(here, post, bob, { createdAt: ago(60) });
    const before = await newIds(post.id, as(alice.id));

    expect(await recordVisitAs(localUser(alice.id), { postId: post.id })).toEqual({ ok: true, recorded: true });
    // The page's re-sort or next page, after the visit was recorded: the same comments are new.
    expect(await newIds(post.id, as(alice.id))).toEqual(before);
    expect(before.ids).toEqual([fresh.id]);
    expect(await recordVisitAs(localUser(alice.id), { postId: post.id })).toEqual({ ok: true, recorded: false });
    expect(await visitEvents()).toHaveLength(2);

    // Once the visit is over, the next one compares against it: nothing from before is new.
    await writer()
      .update(threadVisits)
      .set({ lastVisitAt: ago(45) })
      .where(eq(threadVisits.ownerId, alice.id));
    expect(await newIds(post.id, as(alice.id))).toMatchObject({ count: 0, ids: [] });
  });

  test('the visit counts from its start: a return within it records nothing, one after it rotates', async () => {
    const { here, alice, bob, post } = await world();
    await recordVisitAs(localUser(alice.id), { postId: post.id });
    await visitedAgo(alice.id, post.id, 20);
    const twentyAgo = await markerOf(alice.id, post.id);
    expect(await recordVisitAs(localUser(alice.id), { postId: post.id })).toEqual({ ok: true, recorded: false });
    expect(await markerOf(alice.id, post.id)).toEqual(twentyAgo);

    // A reader who keeps coming back still gets a new visit once the window has passed since this one began.
    const fresh = await seedComment(here, post, bob, { createdAt: ago(10) });
    await visitedAgo(alice.id, post.id, 40);
    expect(await newIds(post.id, as(alice.id))).toMatchObject({ count: 1, ids: [fresh.id] });
    expect(await recordVisitAs(localUser(alice.id), { postId: post.id })).toEqual({ ok: true, recorded: true });
    const rotated = await markerOf(alice.id, post.id);
    expect(rotated?.previousVisitAt && Math.abs(rotated.previousVisitAt.getTime() - ago(40).getTime())).toBeLessThan(5_000);
    expect(await newIds(post.id, as(alice.id))).toMatchObject({ count: 1, ids: [fresh.id] });
    expect(await visitEvents()).toHaveLength(2);
  });

  test('the count covers the whole thread, the marks only the page given', async () => {
    const { here, alice, bob, post } = await world();
    await recordVisitAs(localUser(alice.id), { postId: post.id });
    await visitedAgo(alice.id, post.id, 120);
    const one = await seedComment(here, post, bob, { createdAt: ago(60) });
    await seedComment(here, post, bob, { createdAt: ago(50) });
    const state = await threadVisit(alice.id, post.id, [{ id: one.id, authorId: bob.id, shown: true }]);
    expect(state.newCount).toBe(2);
    expect([...state.newIds]).toEqual([one.id]);
    // A comment the reader does not show (its author blocked, say) is never marked.
    expect((await threadVisit(alice.id, post.id, [{ id: one.id, authorId: bob.id, shown: false }])).newIds.size).toBe(0);
    expect(await threadVisit(null, post.id, [{ id: one.id, authorId: bob.id, shown: true }])).toMatchObject({
      newCount: 0,
      previousVisitAt: null,
    });
  });
});

describe('a visit marker is its owner’s', () => {
  test('a second account neither reads nor moves the first one’s marker', async () => {
    const { here, alice, bob, carol, post } = await world();
    await recordVisitAs(localUser(alice.id), { postId: post.id });
    await visitedAgo(alice.id, post.id, 120);
    await seedComment(here, post, carol, { createdAt: ago(60) });
    const alices = await markerOf(alice.id, post.id);

    // Bob has no marker of his own, so the thread shows him nothing new, whatever alice's says.
    expect(await newIds(post.id, as(bob.id))).toEqual({ count: 0, previous: null, ids: [] });
    expect(await threadVisit(bob.id, post.id, [])).toMatchObject({ newCount: 0, previousVisitAt: null });
    // Recording writes the recorder's own row: the owner comes from the principal, never from input.
    expect(await recordVisitAs(localUser(bob.id), { postId: post.id })).toEqual({ ok: true, recorded: true });
    expect(await markerOf(alice.id, post.id)).toEqual(alices);
    expect(await newIds(post.id, as(alice.id))).toMatchObject({ count: 1 });
    expect(await newIds(post.id, as(bob.id))).toMatchObject({ count: 0 });
  });
});

describe('recording is refused', () => {
  test('without a local person, for a post that is not there or removed, or in a removed community', async () => {
    const { here, alice, news, post } = await world();
    expect(await recordVisitAs({ kind: 'anonymous' }, { postId: post.id })).toMatchObject({ ok: false });
    expect(await recordVisitAs(localUser(alice.id), { postId: '00000000-0000-7000-8000-000000000000' })).toEqual({
      ok: false,
      reason: 'target.not_found',
    });
    const removed = await seedPost(here, news, alice, { removedAt: ago(1) });
    expect(await recordVisitAs(localUser(alice.id), { postId: removed.id })).toEqual({ ok: false, reason: 'target.removed' });
    // A deleted post keeps its thread, so a visit to it counts.
    const deleted = await seedPost(here, news, alice, { deletedAt: ago(1) });
    expect(await recordVisitAs(localUser(alice.id), { postId: deleted.id })).toEqual({ ok: true, recorded: true });
    await seedCommunityRemoval(news);
    expect(await recordVisitAs(localUser(alice.id), { postId: post.id })).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await visitEvents()).toHaveLength(1);
  });
});
