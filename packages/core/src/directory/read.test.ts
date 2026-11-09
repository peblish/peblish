import { inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { actors } from '../db/tables/actors.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db';
import { seedDirectoryWorld } from '../testing/seed-disc';
import { defaultQuery, type DirectoryQuery } from './input.ts';
import { listCommunities } from './read.ts';

let world: Awaited<ReturnType<typeof seedDirectoryWorld>>;
beforeEach(async () => {
  await truncateAll();
  world = await seedDirectoryWorld();
});

const declared = () => ({ actorId: world.people.viewer.id, declared: true });
const undeclared = () => ({ actorId: world.people.minor.id, declared: false });
const list = (query: Partial<DirectoryQuery>, viewer: ReturnType<typeof declared> | null = null) =>
  listCommunities({ ...defaultQuery, ...query }, viewer);
const names = async (query: Partial<DirectoryQuery>, viewer: ReturnType<typeof declared> | null = null) =>
  (await list(query, viewer)).rows.map((row) => row.actor.handle);

describe('what is listed', () => {
  test('lists live communities, local and remote, and leaves out the removed, the deleted, people and anything flagged', async () => {
    expect((await names({ sort: 'name' })).sort()).toEqual(['News', 'art', 'quiet@piefed.test', 'technology@lemmy.test']);
  });

  test('a remote community never lists as NSFW; a local one only for a viewer who declared 16+ and asked', async () => {
    expect(await names({ nsfw: 'show', sort: 'name' }, declared())).toEqual([
      'adult',
      'art',
      'News',
      'quiet@piefed.test',
      'technology@lemmy.test',
    ]);
    expect(await names({ nsfw: 'only' }, declared())).toEqual(['adult']);
    // Signed out and undeclared viewers get Hide whatever the address says.
    for (const viewer of [null, undeclared()]) {
      expect(await names({ nsfw: 'show' }, viewer)).not.toContain('adult');
      expect(await names({ nsfw: 'only' }, viewer)).toHaveLength(4);
    }
    expect(
      (await names({ nsfw: 'show' }, declared())).some((handle) => handle.startsWith('adult_remote') || handle.startsWith('scary')),
    ).toBe(false);
  });

  test('counts each scope under the NSFW setting and the search, and a local scope lists local communities only', async () => {
    expect((await list({})).counts).toEqual({ local: 2, all: 4 });
    expect((await list({ nsfw: 'show' }, declared())).counts).toEqual({ local: 3, all: 5 });
    expect((await list({ q: 'tech' })).counts).toEqual({ local: 0, all: 1 });
    expect(await names({ scope: 'local', sort: 'name' })).toEqual(['art', 'News']);
  });

  test('leaves out a community that opted out of search, local or remote', async () => {
    await writer()
      .update(actors)
      .set({ discoverable: false })
      .where(inArray(actors.id, [world.communities.art.id, world.communities.technology.id]));
    expect((await names({ sort: 'name' })).sort()).toEqual(['News', 'quiet@piefed.test']);
  });

  test('leaves out the communities of a blocked host', async () => {
    vi.resetModules();
    vi.doMock('../resolve/blocked.ts', () => ({ blockedHosts: async () => ['lemmy.test'], hostBlocked: async () => true }));
    const { listCommunities: blockedList } = await import('./read.ts');
    const { rows, counts } = await blockedList(defaultQuery, null);
    expect(rows.map((row) => row.actor.handle).sort()).toEqual(['News', 'art', 'quiet@piefed.test']);
    expect(counts.all).toBe(3);
    vi.doUnmock('../resolve/blocked.ts');
  });
});

describe('what a row says', () => {
  test('counts the members here and the authors this week in the local copy, and gives the viewer their own follow', async () => {
    const { rows } = await list({}, declared());
    const row = (handle: string) => rows.find((entry) => entry.actor.handle === handle)!;
    // Accepted follows only; deleted, removed and older posts do not make anyone active.
    expect(row('News')).toMatchObject({ subscribers: 3, active: 2, follow: 'pending', refreshedAt: null });
    expect(row('technology@lemmy.test')).toMatchObject({
      subscribers: 2,
      active: 3,
      follow: 'accepted',
      refreshedAt: '2026-11-01T12:00:00.000Z',
    });
    expect(row('art')).toMatchObject({ subscribers: 1, active: 0, follow: 'none' });
    expect((await list({})).rows.every((entry) => entry.follow === 'none')).toBe(true);
  });

  test('prints an excerpt of the summary as plain text, with no markup or remote picture', async () => {
    const { rows } = await list({});
    expect(rows.find((row) => row.actor.handle === 'technology@lemmy.test')?.excerpt).toBe('Gadgets & code');
    expect(rows.find((row) => row.actor.handle === 'News')?.excerpt).toBe('News from around the world');
    expect(rows.find((row) => row.actor.handle === 'quiet@piefed.test')?.excerpt).toBeNull();
  });
});

describe('order and paging', () => {
  test.each([
    ['subscribers', ['News', 'technology@lemmy.test', 'art', 'quiet@piefed.test']],
    ['active', ['technology@lemmy.test', 'News', 'art', 'quiet@piefed.test']],
    ['newest', ['art', 'quiet@piefed.test', 'News', 'technology@lemmy.test']],
    ['name', ['art', 'News', 'quiet@piefed.test', 'technology@lemmy.test']],
  ] as const)('sorts by %s, then name', async (sort, expected) => {
    expect(await names({ sort })).toEqual(expected);
  });

  test('searches name, display name and host, with % and _ as plain text', async () => {
    expect(await names({ q: 'WORLD' })).toEqual(['News']);
    expect(await names({ q: 'piefed' })).toEqual(['quiet@piefed.test']);
    expect(await names({ q: 'lemmy.test' })).toEqual(['technology@lemmy.test']);
    expect(await names({ q: '%' })).toEqual([]);
    expect(await names({ q: '_' })).toEqual([]);
  });

  test('a search that is a handle or a link filters nothing', async () => {
    expect(await names({ q: '!lab@lemmy.test' })).toHaveLength(4);
    expect(await names({ q: 'https://lemmy.test/c/lab' })).toHaveLength(4);
  });

  test('pages 25 at a time without repeating or skipping a row, and stops at 500', async () => {
    const { writer } = await import('../db/write.ts');
    const { sql } = await import('drizzle-orm');
    await writer().execute(sql`
      insert into actors (id, ap_id, kind, local, instance_id, name)
      select gen_random_uuid(), 'https://lemmy.test/c/bulk' || s.i, 'Group', false, ${world.instances.lemmy.id}::uuid, 'bulk' || lpad(s.i::text, 3, '0')
      from generate_series(1, 560) as s(i)`);
    const first = await list({ sort: 'name' });
    expect(first.rows).toHaveLength(25);
    expect(first.hasNext).toBe(true);
    const seen = new Set(first.rows.map((row) => row.actor.id));
    let last = first;
    for (let page = 2; page <= 20; page += 1) {
      last = await list({ sort: 'name', page });
      expect(last.page).toBe(page);
      for (const row of last.rows) {
        expect(seen.has(row.actor.id)).toBe(false);
        seen.add(row.actor.id);
      }
    }
    expect(seen.size).toBe(500);
    expect(last.hasNext).toBe(false);
    expect((await list({ sort: 'name', page: 99 })).page).toBe(20);
  });
});
