import { and, asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { follows } from '../db/tables/follows.ts';
import { writer } from '../db/write.ts';
import { sidebarCommunities } from '../feeds/shell.ts';
import { truncateAll } from '../testing/db.ts';
import { outboxEvents, seedCommunityRemoval } from '../testing/seed-az.ts';
import { seedFollow } from '../testing/seed-c1.ts';
import { person, seedPerson } from '../testing/seed-f.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { movePinAs, pinCommunityAs, pinsAmong, unpinCommunityAs } from './pins.ts';
import { communityPins } from './tables.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const alice = await seedPerson(local, 'alice');
  const bob = await seedPerson(local, 'bob');
  const names = ['art', 'bikes', 'cats', 'dogs', 'eels'] as const;
  const groups = await Promise.all(names.map((name) => seedActor(local, 'Group', name)));
  const remote = await seedActor(lemmy, 'Group', 'tech');
  const ids = Object.fromEntries(names.map((name, n) => [name, groups[n]!.id])) as Record<(typeof names)[number], string>;
  for (const group of [...groups, remote]) await seedFollow(alice, group);
  return { alice, bob, me: person(alice.id), them: person(bob.id), ids, remote, all: [...groups.map((g) => g.id), remote.id] };
}

/** The owner's stored order, by community id: dense when it is 0, 1, 2 and so on. */
const stored = async (ownerId: string) =>
  (
    await writer()
      .select({ communityId: communityPins.communityId, position: communityPins.position })
      .from(communityPins)
      .where(eq(communityPins.ownerId, ownerId))
      .orderBy(asc(communityPins.position))
  ).map((row) => [row.communityId, row.position] as const);

const pinEvents = async () =>
  (await outboxEvents()).filter((event) => (event as { type: string }).type.startsWith('pin.')) as { type: string }[];

describe('pin, unpin and move', () => {
  test('refusals: signed out, not followed, missing, closed, and a move of a pin that is not there', async () => {
    const w = await world();
    const missing = '019aaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
    const closed = await seedActor(await seedInstance('other.test', false), 'Group', 'gone');
    await seedFollow(w.alice, closed);
    await seedCommunityRemoval(closed);

    expect(await pinCommunityAs({ kind: 'anonymous' }, { communityId: w.ids.art })).toEqual({ ok: false, reason: 'auth.required' });
    expect(await unpinCommunityAs({ kind: 'anonymous' }, { communityId: w.ids.art })).toEqual({ ok: false, reason: 'auth.required' });
    expect(await movePinAs({ kind: 'anonymous' }, { communityId: w.ids.art, toPosition: 0 })).toEqual({
      ok: false,
      reason: 'auth.required',
    });
    expect(await pinCommunityAs(w.them, { communityId: w.ids.art })).toEqual({ ok: false, reason: 'pin.not_followed' });
    expect(await pinCommunityAs(w.me, { communityId: missing })).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await pinCommunityAs(w.me, { communityId: w.alice.id })).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await pinCommunityAs(w.me, { communityId: closed.id })).toEqual({ ok: false, reason: 'community.removed' });
    expect(await movePinAs(w.me, { communityId: w.ids.art, toPosition: 0 })).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await pinEvents()).toEqual([]);
  });

  test('a pin joins the end, pinning twice changes nothing, unpinning closes the gap; events only for real changes', async () => {
    const w = await world();
    expect(await pinCommunityAs(w.me, { communityId: w.ids.cats })).toEqual({ ok: true, position: 0 });
    expect(await pinCommunityAs(w.me, { communityId: w.ids.art })).toEqual({ ok: true, position: 1 });
    expect(await pinCommunityAs(w.me, { communityId: w.remote.id })).toEqual({ ok: true, position: 2 });
    expect(await pinCommunityAs(w.me, { communityId: w.ids.art })).toEqual({ ok: true, position: 1 });
    expect(await stored(w.alice.id)).toEqual([
      [w.ids.cats, 0],
      [w.ids.art, 1],
      [w.remote.id, 2],
    ]);

    expect(await unpinCommunityAs(w.me, { communityId: w.ids.cats })).toEqual({ ok: true, pinned: false });
    expect(await unpinCommunityAs(w.me, { communityId: w.ids.cats })).toEqual({ ok: true, pinned: false });
    expect(await stored(w.alice.id)).toEqual([
      [w.ids.art, 0],
      [w.remote.id, 1],
    ]);
    expect(await movePinAs(w.me, { communityId: w.ids.art, toPosition: 0 })).toEqual({ ok: true, position: 0 });

    expect(await pinEvents()).toEqual([
      { type: 'pin.added', v: 1, ownerId: w.alice.id, communityId: w.ids.cats, position: 0 },
      { type: 'pin.added', v: 1, ownerId: w.alice.id, communityId: w.ids.art, position: 1 },
      { type: 'pin.added', v: 1, ownerId: w.alice.id, communityId: w.remote.id, position: 2 },
      { type: 'pin.removed', v: 1, ownerId: w.alice.id, communityId: w.ids.cats, position: 0 },
    ]);
  });

  test('a move shifts the pins between by one, either way, and past the end means last', async () => {
    const w = await world();
    for (const name of ['art', 'bikes', 'cats', 'dogs'] as const) await pinCommunityAs(w.me, { communityId: w.ids[name] });
    expect(await movePinAs(w.me, { communityId: w.ids.art, toPosition: 2 })).toEqual({ ok: true, position: 2 });
    expect((await stored(w.alice.id)).map(([id]) => id)).toEqual([w.ids.bikes, w.ids.cats, w.ids.art, w.ids.dogs]);
    expect(await movePinAs(w.me, { communityId: w.ids.dogs, toPosition: 0 })).toEqual({ ok: true, position: 0 });
    expect((await stored(w.alice.id)).map(([id]) => id)).toEqual([w.ids.dogs, w.ids.bikes, w.ids.cats, w.ids.art]);
    expect(await movePinAs(w.me, { communityId: w.ids.dogs, toPosition: 99 })).toEqual({ ok: true, position: 3 });
    expect(await stored(w.alice.id)).toEqual([
      [w.ids.bikes, 0],
      [w.ids.cats, 1],
      [w.ids.art, 2],
      [w.ids.dogs, 3],
    ]);
    const moved = (await pinEvents()).filter((event) => event.type === 'pin.moved');
    expect(moved).toEqual([
      { type: 'pin.moved', v: 1, ownerId: w.alice.id, communityId: w.ids.art, from: 0, to: 2 },
      { type: 'pin.moved', v: 1, ownerId: w.alice.id, communityId: w.ids.dogs, from: 3, to: 0 },
      { type: 'pin.moved', v: 1, ownerId: w.alice.id, communityId: w.ids.dogs, from: 0, to: 3 },
    ]);
  });
});

test("two accounts: the second can neither read nor change the first's pins", async () => {
  const w = await world();
  await seedFollow(w.bob, { id: w.ids.art });
  await pinCommunityAs(w.me, { communityId: w.ids.art });
  await pinCommunityAs(w.me, { communityId: w.ids.bikes });
  const before = await stored(w.alice.id);

  // Reading: Bob's view of the same communities has no pins, and his shell marks none.
  expect([...(await pinsAmong(w.bob.id, w.all))]).toEqual([]);
  expect((await sidebarCommunities(w.bob.id)).local.map(({ pinned, pinPosition }) => [pinned, pinPosition])).toEqual([[false, null]]);
  expect([...(await pinsAmong(null, w.all))]).toEqual([]);

  // Writing: the entry points take the owner from the principal, so Bob only ever touches his own rows.
  expect(await unpinCommunityAs(w.them, { communityId: w.ids.art })).toEqual({ ok: true, pinned: false });
  expect(await movePinAs(w.them, { communityId: w.ids.bikes, toPosition: 0 })).toEqual({ ok: false, reason: 'target.not_found' });
  expect(await pinCommunityAs(w.them, { communityId: w.ids.bikes })).toEqual({ ok: false, reason: 'pin.not_followed' });
  expect(await pinCommunityAs(w.them, { communityId: w.ids.art })).toEqual({ ok: true, position: 0 });
  expect(await stored(w.alice.id)).toEqual(before);
  expect(await stored(w.bob.id)).toEqual([[w.ids.art, 0]]);
});

test('racing moves of one owner take turns: the order stays dense and is one of the serial outcomes', async () => {
  const w = await world();
  for (const name of ['art', 'bikes', 'cats', 'dogs', 'eels'] as const) await pinCommunityAs(w.me, { communityId: w.ids[name] });
  const order = (await stored(w.alice.id)).map(([id]) => id);

  // What a serial run of the two moves gives, in either order.
  const apply = (list: string[], id: string, to: number) => {
    const rest = list.filter((x) => x !== id);
    return [...rest.slice(0, to), id, ...rest.slice(to)];
  };
  let current = order;
  for (let round = 0; round < 12; round++) {
    const a = current[round % 5]!;
    const b = current[(round + 2) % 5]!;
    const toA = (round * 3) % 5;
    const toB = (round * 2 + 1) % 5;
    const results = await Promise.all([
      movePinAs(w.me, { communityId: a, toPosition: toA }),
      movePinAs(w.me, { communityId: b, toPosition: toB }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const after = await stored(w.alice.id);
    expect(after.map(([, position]) => position)).toEqual([0, 1, 2, 3, 4]);
    const ids = after.map(([id]) => id);
    expect([apply(apply(current, a, toA), b, toB), apply(apply(current, b, toB), a, toA)]).toContainEqual(ids);
    current = ids;
  }
});

test('racing pins and unpins of one owner keep the order dense', async () => {
  const w = await world();
  await pinCommunityAs(w.me, { communityId: w.ids.art });
  await pinCommunityAs(w.me, { communityId: w.ids.bikes });
  await Promise.all([
    pinCommunityAs(w.me, { communityId: w.ids.cats }),
    pinCommunityAs(w.me, { communityId: w.ids.dogs }),
    unpinCommunityAs(w.me, { communityId: w.ids.art }),
    pinCommunityAs(w.me, { communityId: w.ids.eels }),
  ]);
  expect((await stored(w.alice.id)).map(([, position]) => position)).toEqual([0, 1, 2, 3]);
});

describe('hidden pins', () => {
  test('a pin of a community the owner left or may not see leaves the sidebar, keeps its place, and comes back on a re-follow', async () => {
    const w = await world();
    for (const name of ['art', 'bikes', 'cats', 'dogs'] as const) await pinCommunityAs(w.me, { communityId: w.ids[name] });
    await writer()
      .delete(follows)
      .where(and(eq(follows.followerId, w.alice.id), eq(follows.followeeId, w.ids.bikes)));
    await seedCommunityRemoval({ id: w.ids.cats });

    const shell = await sidebarCommunities(w.alice.id);
    const places = (rows: typeof shell.local) =>
      Object.fromEntries(rows.filter((row) => row.pinned).map((row) => [row.name, row.pinPosition]));
    expect(places(shell.local)).toEqual({ art: 0, dogs: 1 });
    expect(shell.local.map((row) => row.name)).not.toContain('cats');

    // Moves count the shown pins only: dogs moves before art across the hidden bikes and cats.
    expect(await movePinAs(w.me, { communityId: w.ids.dogs, toPosition: 0 })).toEqual({ ok: true, position: 0 });
    expect(places((await sidebarCommunities(w.alice.id)).local)).toEqual({ dogs: 0, art: 1 });
    expect(await movePinAs(w.me, { communityId: w.ids.bikes, toPosition: 0 })).toEqual({ ok: false, reason: 'target.not_found' });
    // A pin of an unfollowed community can still be dropped.
    expect(await unpinCommunityAs(w.me, { communityId: w.ids.cats })).toEqual({ ok: true, pinned: false });
    expect((await stored(w.alice.id)).map(([, position]) => position)).toEqual([0, 1, 2]);

    await seedFollow(w.alice, { id: w.ids.bikes }, 'pending');
    const back = (await sidebarCommunities(w.alice.id)).local;
    expect(places(back)).toEqual({ dogs: 0, art: 1, bikes: 2 });
    expect(back.find((row) => row.name === 'bikes')?.followState).toBe('pending');
  });

  test("a gap a purged community left takes no one's place: the next pin goes after the last", async () => {
    const w = await world();
    await pinCommunityAs(w.me, { communityId: w.ids.art });
    await pinCommunityAs(w.me, { communityId: w.ids.bikes });
    await writer()
      .delete(communityPins)
      .where(and(eq(communityPins.ownerId, w.alice.id), eq(communityPins.communityId, w.ids.art)));
    expect(await pinCommunityAs(w.me, { communityId: w.ids.cats })).toEqual({ ok: true, position: 1 });
    expect(await stored(w.alice.id)).toEqual([
      [w.ids.bikes, 1],
      [w.ids.cats, 2],
    ]);
    expect(Object.fromEntries(await pinsAmong(w.alice.id, w.all))).toEqual({ [w.ids.bikes]: 0, [w.ids.cats]: 1 });
  });
});
