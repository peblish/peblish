import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { posts } from '@peblish/core/db/tables/content';
import { communityModerators, modlog } from '@peblish/core/db/tables/moderation';
import { deliveries } from '@peblish/core/delivery/tables';
import { communityBans } from '@peblish/core/moderation/tables';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedLabWorld } from '@peblish/core/testing/seed-fed-b';
import { readFixture } from '../test/manifest.ts';
import { forgetDeferredMirrors } from '@peblish/core/remote/moderators';
import { fetchModerators, mirrorDue } from './moderators/refresh.ts';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';

// Lock, featured and Block from the captured Lemmy and PieFed traffic: what peers sent when a
// moderator locked, pinned and banned, once inside the community's Announce and once straight
// to a community here. The state each one leaves is read back from the tables.

type Lab = Awaited<ReturnType<typeof seedLabWorld>>;
let lab: Lab;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  forgetDeferredMirrors();
  lab = await seedLabWorld();
});

const send = async (fixture: string) => {
  const { stored } = await deliverRow(readFixture(`wire/${fixture}`) as Record<string, unknown>, (row) => processRow(row));
  return stored;
};
const post = async (apId: string) => (await db().select().from(posts).where(eq(posts.apId, apId)))[0];
const ban = async (communityApId: string, userApId: string) =>
  (
    await db()
      .select()
      .from(communityBans)
      .where(and(eq(communityBans.communityId, lab.id(communityApId)), eq(communityBans.actorId, lab.id(userApId))))
  )[0];
const applied = { state: 'applied', error: null };

const user = 'https://feddit.lab.test/ap/u.m1108022723';

describe('announced by a remote community (the community’s Announce is the authority)', () => {
  test.each([
    [
      'Lemmy',
      'lemmy-0.19.21/inbound',
      'https://lemmy.lab.test/post/15',
      'https://lemmy.lab.test/c/lab',
      ['0051-announce-lock', '0052-announce-undo-lock'],
      ['0053-announce-add', '0054-announce-remove'],
      ['0055-announce-block', '0057-announce-undo-block'],
    ],
    [
      'PieFed',
      'piefed-1.8.11/inbound',
      'https://piefed.lab.test/c/pflab@piefed.lab.test/p/13/native-mod-target-1108022723',
      'https://piefed.lab.test/c/pflab',
      ['0067-announce-lock', '0068-announce-undo-lock'],
      ['0069-announce-add', '0070-announce-remove'],
      ['0071-announce-block'],
    ],
  ])('%s: lock and unlock, pin and unpin, ban and unban', async (_peer, dir, target, community, locks, pins, bans) => {
    expect(await send(`${dir}/inbound-${locks[0]}.json`)).toEqual(applied);
    expect((await post(target))?.locked).toBe(true);
    if (locks[1]) {
      expect(await send(`${dir}/inbound-${locks[1]}.json`)).toEqual(applied);
      expect((await post(target))?.locked).toBe(false);
    }

    expect(await send(`${dir}/inbound-${pins[0]}.json`)).toEqual(applied);
    expect((await post(target))?.featuredCommunity).toBe(true);
    expect(await send(`${dir}/inbound-${pins[1]}.json`)).toEqual(applied);
    expect((await post(target))?.featuredCommunity).toBe(false);

    expect(await send(`${dir}/inbound-${bans[0]}.json`)).toEqual(applied);
    expect(await ban(community, user)).toBeDefined();
    if (bans[1]) {
      expect(await send(`${dir}/inbound-${bans[1]}.json`)).toEqual(applied);
      expect(await ban(community, user)).toBeUndefined();
    }
    // Each is in the modlog under the announcing community’s authority, with that community recorded.
    const rows = await db().select().from(modlog);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(row.authority).toMatchObject({ kind: 'community-announce' });
      expect(row.details).toMatchObject({ announcedBy: community });
    }
  });

  test('a PieFed ban ends when its endTime does, and a ban whose end has passed is skipped', async () => {
    expect(await send('piefed-1.8.11/inbound/inbound-0071-announce-block.json')).toEqual(applied);
    expect((await ban('https://piefed.lab.test/c/pflab', user))?.expiresAt?.getUTCFullYear()).toBe(2100);
    const document = readFixture('wire/piefed-1.8.11/inbound/inbound-0071-announce-block.json') as { object: Record<string, unknown> };
    const past = {
      ...document,
      id: 'https://piefed.lab.test/activities/announce/past',
      object: {
        ...document.object,
        id: 'https://piefed.lab.test/activities/block/past',
        endTime: '2020-01-01T00:00:00+00:00',
        expires: '2020-01-01T00:00:00+00:00',
      },
    };
    const { stored } = await deliverRow(past, (row) => processRow(row));
    expect(stored?.error).toMatch(/^block\.expired/);
  });
});

describe('sent straight to the spike’s community by a moderator appointed there', () => {
  test('PieFed’s Lock, Undo(Lock), Add and Remove, and the relay of each to the community’s followers', async () => {
    // lemmy.lab.test/post/19 is a post in the spike's community.
    const target = 'https://lemmy.lab.test/post/19';
    expect(await send('piefed-1.8.11/inbound/inbound-0085-lock.json')).toEqual(applied);
    expect((await post(target))?.locked).toBe(true);
    expect(await send('piefed-1.8.11/inbound/inbound-0086-undo-lock.json')).toEqual(applied);
    expect((await post(target))?.locked).toBe(false);
    expect(await send('piefed-1.8.11/inbound/inbound-0087-add.json')).toEqual(applied);
    expect((await post(target))?.featuredCommunity).toBe(true);
    expect(await send('piefed-1.8.11/inbound/inbound-0088-remove.json')).toEqual(applied);
    expect((await post(target))?.featuredCommunity).toBe(false);
    const relayed = await db().select().from(deliveries);
    expect(relayed.length).toBeGreaterThan(0);
    expect(new Set(relayed.map((row) => row.activityType))).toEqual(new Set(['Announce']));
    // Never back to the server it came from.
    expect(relayed.every((row) => !row.inboxUrl.startsWith('https://piefed.lab.test'))).toBe(true);
  });

  test('Lemmy’s Block from a user who is not a moderator here is refused with its reason, and changes nothing', async () => {
    for (const fixture of ['inbound-0075-lock', 'inbound-0077-add', 'inbound-0079-block']) {
      const stored = await send(`lemmy-0.19.21/inbound/${fixture}.json`);
      expect(stored?.state).toBe('skipped');
      expect(stored?.error).toMatch(/^(mod\.moderator_required|target\.missing)/);
    }
    expect(await ban('https://feddit.lab.test/ap/c.spike', 'https://piefed.lab.test/u/pfuser')).toBeUndefined();
  });

  test('a moderator’s Block and its Undo(Block) ban and unban someone in the spike, and a moderator cannot be banned', async () => {
    const block = readFixture('wire/lemmy-0.19.21/inbound/inbound-0079-block.json') as Record<string, unknown>;
    const undo = readFixture('wire/lemmy-0.19.21/inbound/inbound-0080-undo-block.json') as Record<string, unknown>;
    const as = (actor: string, object: string, id: string) => {
      const inner = { ...block, id: `https://lemmy.lab.test/activities/block/${id}`, actor, object };
      return { inner, undo: { ...undo, id: `https://lemmy.lab.test/activities/undo/${id}`, actor, object: inner } };
    };
    const spike = 'https://feddit.lab.test/ap/c.spike';
    const lemmyuser = 'https://lemmy.lab.test/u/lemmyuser';
    const lemmyadmin = 'https://lemmy.lab.test/u/lemmyadmin';
    const process = (json: Record<string, unknown>) => deliverRow(json, (row) => processRow(row)).then((r) => r.stored);

    const one = as(lemmyadmin, lemmyuser, 'ban-1');
    expect(await process(one.inner)).toEqual(applied);
    expect(await ban(spike, lemmyuser)).toBeDefined();
    expect(await process(one.undo)).toEqual(applied);
    expect(await ban(spike, lemmyuser)).toBeUndefined();

    const protectedOne = as(lemmyadmin, 'https://piefed.lab.test/u/pfuser', 'ban-2');
    expect((await process(protectedOne.inner))?.error).toBe('target.protected');
    expect(await ban(spike, 'https://piefed.lab.test/u/pfuser')).toBeUndefined();
  });
});

describe('a remote community’s moderators', () => {
  test('an Add on its moderators collection mirrors the collection it publishes, with an explicit expiry', async () => {
    // Lemmy's Add of a moderator (peer-log) is for the spike here; the lab community's list is read from its own origin.
    const collection = 'https://lemmy.lab.test/c/lab/moderators';
    const moderators = { type: 'OrderedCollection', id: collection, orderedItems: ['https://lemmy.lab.test/u/lemmyadmin'] };
    const add = {
      id: 'https://lemmy.lab.test/activities/announce/add/mod',
      type: 'Announce',
      actor: 'https://lemmy.lab.test/c/lab',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: ['https://lemmy.lab.test/c/lab/followers'],
      object: {
        id: 'https://lemmy.lab.test/activities/add/mod',
        type: 'Add',
        actor: 'https://lemmy.lab.test/u/lemmyadmin',
        object: 'https://lemmy.lab.test/u/lemmyadmin',
        target: collection,
        audience: 'https://lemmy.lab.test/c/lab',
        cc: ['https://lemmy.lab.test/c/lab'],
        to: ['https://www.w3.org/ns/activitystreams#Public'],
      },
    };
    const { fetch } = stubFetch({ [collection]: { body: moderators } });
    const { stored } = await deliverRow(add, (row) => processRow(row, { fetch }));
    expect(stored).toEqual(applied);
    const [row] = await db()
      .select()
      .from(communityModerators)
      .where(eq(communityModerators.communityId, lab.id('https://lemmy.lab.test/c/lab')));
    expect(row).toMatchObject({ source: 'remote', role: 'moderator' });
    expect(row?.verifiedAt).toBeInstanceOf(Date);
    expect((row?.expiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(11.9 * 3600_000);
  });
});

describe('keeping the mirror fresh', () => {
  const collection = 'https://lemmy.lab.test/c/lab/moderators';
  const moderators = { type: 'OrderedCollection', id: collection, orderedItems: ['https://lemmy.lab.test/u/lemmyadmin'] };
  const mirrored = async () =>
    (
      await db()
        .select()
        .from(communityModerators)
        .where(eq(communityModerators.communityId, lab.id('https://lemmy.lab.test/c/lab')))
    ).length;

  test('the job mirrors a followed community that has none yet, and leaves one it cannot read for the next run', async () => {
    expect(await mirrorDue({ fetch: stubFetch({}).fetch })).toBe(0);
    expect(await mirrored()).toBe(0);
    expect(await mirrorDue({ fetch: stubFetch({ [collection]: { body: moderators } }).fetch })).toBe(1);
    expect(await mirrored()).toBe(1);
    // Fresh now: nothing is due until the mirror runs low.
    expect(await mirrorDue({ fetch: stubFetch({ [collection]: { body: moderators } }).fetch })).toBe(0);
  });
});

describe('reading a community’s moderators', () => {
  const community = 'https://lemmy.lab.test/c/lab';
  const collection = `${community}/moderators`;
  const admin = 'https://lemmy.lab.test/u/lemmyadmin';
  const list = (orderedItems: string[], id = collection) => ({ type: 'OrderedCollection', id, orderedItems });

  test('is done without following a redirect, from the community’s own origin and under the name it gave', async () => {
    const id = lab.id(community);
    const redirected = stubFetch({
      [collection]: { status: 301, location: 'https://evil.test/m' },
      'https://evil.test/m': { body: list([admin]) },
    });
    await expect(fetchModerators(id, redirected.fetch)).rejects.toMatchObject({ reason: 'moderators.unreachable' });
    expect(redirected.requests.map((request) => request.url)).toEqual([collection]);
    expect(redirected.requests[0]?.init).toMatchObject({ maxRedirects: 0 });

    const renamed = stubFetch({ [collection]: { body: list([admin], `${community}/other`) } });
    await expect(fetchModerators(id, renamed.fetch)).rejects.toMatchObject({ reason: 'moderators.unreachable' });

    const foreign = 'https://evil.test/c/lab/moderators';
    await writer().update(actors).set({ moderatorsUrl: foreign }).where(eq(actors.id, id));
    const elsewhere = stubFetch({ [foreign]: { body: list([admin], foreign) } });
    await expect(fetchModerators(id, elsewhere.fetch)).rejects.toMatchObject({ reason: 'moderators.unreachable' });
    expect(elsewhere.requests).toEqual([]);
  });

  test('leaves out a moderator nobody here has seen and whose server is down, and mirrors the rest', async () => {
    const ghost = 'https://down.test/u/ghost';
    const { fetch } = stubFetch({ [collection]: { body: list([ghost, admin]) }, [ghost]: { status: 503 } });
    const fetched = await fetchModerators(lab.id(community), fetch);
    expect(fetched.moderatorIds).toEqual([lab.id(admin)]);
  });

  test('an empty collection is mirrored once and not asked for again until the backoff has passed', async () => {
    const empty = stubFetch({ [collection]: { body: list([]) } });
    // (The other followed community has no stubbed collection, so it is asked again each run.)
    const asked = () => empty.requests.filter((request) => request.url === collection).length;
    expect(await mirrorDue({ fetch: empty.fetch })).toBe(1);
    expect(asked()).toBe(1);
    expect(await mirrorDue({ fetch: empty.fetch })).toBe(0);
    expect(asked()).toBe(1);
    // The collection fills up later; once the community is asked again it is mirrored.
    forgetDeferredMirrors();
    expect(await mirrorDue({ fetch: stubFetch({ [collection]: { body: list([admin]) } }).fetch })).toBe(1);
    expect(
      await db()
        .select()
        .from(communityModerators)
        .where(eq(communityModerators.communityId, lab.id(community))),
    ).toHaveLength(1);
  });
});
