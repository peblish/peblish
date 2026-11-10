import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts } from '@peblish/core/db/tables/content';
import { truncateAll } from '@peblish/core/testing/db';
import { seedInstance } from '@peblish/core/testing/seed';
import { seedComment } from '@peblish/core/testing/seed-az';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedFollow, seedInboundWorld, seedPeerActor } from '@peblish/core/testing/seed-fed-b';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { hosts } from './test-support.ts';

// Mbin 1.11 never announces: it sends a magazine's Create, Update and Delete straight to the
// magazine's remote subscribers, and addresses a comment's Delete to the post's author before the
// community. The documents below were captured from the lab's inbox_raw (2026-11-10), with the
// lab's hosts mapped onto the test world: mbin.lab.test is mbin.test (its magazine `/m/lab` is
// seeded at `/c/lab`), peblish.lab.test's !lab is this world's !spike and alice is alice.

const mbin = 'https://mbin.test';
const magazine = `${mbin}/c/lab`;
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const context = ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1', `${mbin}/contexts`];

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
let peers: Record<'mbinadmin' | 'mbinuser' | 'magazine', Awaited<ReturnType<typeof seedPeerActor>>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
  const instance = await seedInstance('mbin.test', false);
  peers = {
    mbinadmin: await seedPeerActor(instance, 'Person', 'mbinadmin'),
    mbinuser: await seedPeerActor(instance, 'Person', 'mbinuser'),
    magazine: await seedPeerActor(instance, 'Group', 'lab'),
  };
});

const followMagazine = () => seedFollow(world.alice, peers.magazine, 'https://fed-b.test/ap/activity/follow-mbin');
const deliver = (json: Record<string, unknown>) => deliverRow(json, (row) => processRow(row, { fetch: stubFetch({}).fetch }));
const postRow = async (apId: string) => (await db().select().from(posts).where(eq(posts.apId, apId)))[0];

/** P3: Mbin's admin starts a thread in its own magazine (captured, `/f/object/...` ids as Mbin makes them). */
const page = (author: string, n: number) => ({
  id: `${mbin}/m/lab/t/${n}`,
  type: 'Page',
  attributedTo: author,
  inReplyTo: null,
  to: [magazine, PUBLIC],
  cc: [`${author}/followers`],
  name: `P3 mbin ${n}`,
  audience: magazine,
  content: '<p>The mbin community starts this one.</p>\n',
  summary: `P3 mbin ${n} #lab`,
  mediaType: 'text/html',
  source: { content: 'The mbin community starts this one.', mediaType: 'text/markdown' },
  tag: [{ type: 'Hashtag', href: `${mbin}/tag/lab`, name: '#lab' }],
  commentsEnabled: true,
  sensitive: false,
  stickied: false,
  published: '2026-11-09T16:07:27+00:00',
  contentMap: { en: '<p>The mbin community starts this one.</p>\n' },
});
const create = (actor: string, object: Record<string, unknown>, n: number) => ({
  '@context': context,
  id: `${new URL(actor).origin}/f/object/create-${n}`,
  type: 'Create',
  actor,
  published: '2026-11-09T16:07:27+00:00',
  to: [magazine, PUBLIC],
  cc: [`${actor}/followers`],
  object,
  audience: magazine,
});
/** Mbin's Delete of its own thread or comment: a Tombstone, addressed as captured. */
const remove = (actor: string, objectApId: string, n: number, to: string[], cc: string[]) => ({
  '@context': context,
  id: `${mbin}/f/object/delete-${n}`,
  type: 'Delete',
  actor,
  object: { id: objectApId, type: 'Tombstone' },
  to,
  cc,
});

describe("Mbin's unannounced Create, Update and Delete in its own magazine", () => {
  test('apply when the signer is on the magazine’s host, it is addressed to the magazine and someone here follows it', async () => {
    await followMagazine();
    const thread = page(peers.mbinadmin.apId, 10);
    expect((await deliver(create(peers.mbinadmin.apId, thread, 10))).stored).toEqual({ state: 'applied', error: null });
    expect(await postRow(thread.id)).toMatchObject({ title: 'P3 mbin 10', communityId: peers.magazine.id, deletedAt: null });

    const edited = { ...create(peers.mbinadmin.apId, { ...thread, name: 'P3 mbin 10 (edited)' }, 11), type: 'Update' };
    expect((await deliver(edited)).stored).toEqual({ state: 'applied', error: null });
    expect((await postRow(thread.id))?.title).toBe('P3 mbin 10 (edited)');

    const gone = remove(peers.mbinadmin.apId, thread.id, 12, [magazine, PUBLIC], [`${peers.mbinadmin.apId}/followers`]);
    expect((await deliver(gone)).stored).toEqual({ state: 'applied', error: null });
    expect((await postRow(thread.id))?.deletedAt).not.toBeNull();
  });

  test('are still unannounced when nobody here follows the magazine', async () => {
    const thread = page(peers.mbinadmin.apId, 20);
    expect((await deliver(create(peers.mbinadmin.apId, thread, 20))).stored).toEqual({
      state: 'skipped',
      error: `community.unannounced ${magazine}`,
    });
    expect(await postRow(thread.id)).toBeUndefined();
  });

  test('from an author on another host still need the magazine’s Announce', async () => {
    await followMagazine();
    const thread = { ...page(hosts.lemmyuser, 30), id: 'https://lemmy.test/post/30' };
    expect((await deliver(create(hosts.lemmyuser, thread, 30))).stored).toEqual({
      state: 'skipped',
      error: `community.unannounced ${magazine}`,
    });
    expect(await postRow(thread.id)).toBeUndefined();
  });

  test('a Delete is not a removal: someone else’s thread still needs a moderator core knows', async () => {
    await followMagazine();
    const thread = page(peers.mbinadmin.apId, 40);
    await deliver(create(peers.mbinadmin.apId, thread, 40));
    const theirs = { ...remove(peers.mbinuser.apId, thread.id, 41, [magazine, PUBLIC], []), summary: 'spam' };
    expect((await deliver(theirs)).stored).toEqual({ state: 'skipped', error: 'mod.moderator_required' });
    expect((await postRow(thread.id))?.removedAt).toBeNull();
  });
});

describe("Mbin's Delete of its comment on a post here", () => {
  test('names the community after the post’s author, and the community is found among every addressee', async () => {
    const spike = world.community.apId;
    const alice = world.alice.apId;
    const comment = await seedComment(world.instances.local, world.t1, peers.mbinuser, {
      apId: `${mbin}/m/lab@fed-b.test/t/14/-/comment/5`,
      local: false,
    });
    // As captured for C1: Public and the post's author in `to`, the community and the followers in `cc`, no audience.
    const json = remove(peers.mbinuser.apId, comment.apId, 50, [PUBLIC, alice], [spike, `${peers.mbinuser.apId}/followers`]);
    expect((await deliver(json)).stored).toEqual({ state: 'applied', error: null });
    expect((await db().select().from(comments).where(eq(comments.id, comment.id)))[0]?.deletedAt).not.toBeNull();
  });

  test('naming another community anywhere and this one nowhere is still a mismatch', async () => {
    const comment = await seedComment(world.instances.local, world.t1, peers.mbinuser, {
      apId: `${mbin}/m/lab@fed-b.test/t/14/-/comment/6`,
      local: false,
    });
    const json = remove(peers.mbinuser.apId, comment.apId, 60, [PUBLIC], [magazine]);
    expect((await deliver(json)).stored).toEqual({
      state: 'skipped',
      error: `community.mismatch ${magazine} is not ${world.community.apId}`,
    });
  });
});
