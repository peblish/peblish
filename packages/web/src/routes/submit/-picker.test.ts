import type { SessionView } from '@peblish/schema/session';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// The composer's community picker (pickerFor), with core's reads stubbed: local communities by
// name, the person's follows, and which of a list the person moderates.

type Local = {
  actor: { id: string; handle: string };
  postingRestrictedToMods: boolean;
  subscribers: number;
  sensitive: boolean;
  nsfl: boolean;
};
type Follow = {
  id: string;
  name: string;
  host: string;
  local: boolean;
  state: 'accepted' | 'pending';
  postingRestrictedToMods: boolean;
  sensitive: boolean;
  nsfl: boolean;
};

const core = vi.hoisted(() => ({
  local: [] as Local[],
  follows: [] as Follow[],
  staffOf: new Set<string>(),
  listLocalCommunities: vi.fn(),
  moderatedAmong: vi.fn(),
}));
vi.mock('@peblish/core/communities/read', () => ({
  listLocalCommunities: core.listLocalCommunities,
  moderatedAmong: core.moderatedAmong,
  readCommunity: async () => null,
}));
vi.mock('@peblish/core/follows/read', () => ({ followedCommunities: async () => core.follows }));
const { pickerFor, pickerMax } = await import('./-picker.ts');

const local = (name: string, extra: Partial<Local> = {}): Local => ({
  actor: { id: `id-${name}`, handle: name },
  postingRestrictedToMods: false,
  subscribers: 3,
  sensitive: false,
  nsfl: false,
  ...extra,
});
const follow = (name: string, extra: Partial<Follow> = {}): Follow => ({
  id: `id-${name}`,
  name,
  host: 'lemmy.test',
  local: false,
  state: 'accepted',
  postingRestrictedToMods: false,
  sensitive: false,
  nsfl: false,
  ...extra,
});
const person = (extra: Partial<SessionView> = {}): SessionView => ({
  userId: 'user',
  actorId: 'me',
  name: 'mira',
  displayName: null,
  siteRole: 'user',
  emailVerified: true,
  twoFactorEnabled: false,
  ageDeclaredAt: null,
  ...extra,
});

beforeEach(() => {
  core.local = [];
  core.follows = [];
  core.staffOf = new Set();
  // As core's: by name, at most `limit`, `ids` keeping only those; sensitive ones only when asked.
  core.listLocalCommunities
    .mockReset()
    .mockImplementation(async (options: { includeSensitive?: boolean; limit?: number; ids?: string[] }) =>
      core.local
        .filter((row) => options.includeSensitive || !(row.sensitive || row.nsfl))
        .filter((row) => !options.ids || options.ids.includes(row.actor.id))
        .slice(0, options.limit ?? 200),
    );
  core.moderatedAmong
    .mockReset()
    .mockImplementation(async (_actorId: string, ids: string[]) => new Set(ids.filter((id) => core.staffOf.has(id))));
});

const none = () => null;

describe('a person with a handful of follows', () => {
  test('sees every local community by name, then the remote ones they follow, as before, with one moderator query', async () => {
    core.local = [local('art'), local('notices', { postingRestrictedToMods: true }), local('news'), local('adults', { sensitive: true })];
    core.follows = [
      follow('news', { host: 'feddit.test', local: true }),
      follow('technology'),
      follow('announcements', { postingRestrictedToMods: true }),
      follow('pending', { state: 'pending' }),
      follow('nsfw', { sensitive: true }),
    ];
    core.staffOf = new Set(['id-announcements']);
    const picker = await pickerFor(person(), none);
    expect(picker.communities).toEqual([
      { id: 'id-art', handle: 'art', local: true, subscribers: 3, restricted: false, canPost: true },
      { id: 'id-notices', handle: 'notices', local: true, subscribers: 3, restricted: true, canPost: false },
      { id: 'id-news', handle: 'news', local: true, subscribers: 3, restricted: false, canPost: true },
      { id: 'id-technology', handle: 'technology@lemmy.test', local: false, subscribers: null, restricted: false, canPost: true },
      { id: 'id-announcements', handle: 'announcements@lemmy.test', local: false, subscribers: null, restricted: true, canPost: true },
    ]);
    expect(picker.truncated).toBe(false);
    expect(core.moderatedAmong.mock.calls).toEqual([['me', ['id-notices', 'id-announcements']]]);
    expect(core.listLocalCommunities).toHaveBeenCalledTimes(1);
  });

  test('a site admin posts anywhere and asks nothing about moderators', async () => {
    core.local = [local('notices', { postingRestrictedToMods: true })];
    const picker = await pickerFor(person({ siteRole: 'admin' }), none);
    expect(picker.communities.map(({ canPost }) => canPost)).toEqual([true]);
    expect(core.moderatedAmong.mock.calls).toEqual([['me', []]]);
  });

  test('the community the form starts in is chosen from what the picker lists', async () => {
    core.local = [local('art'), local('news')];
    const picker = await pickerFor(person(), (rows) => rows.find(({ handle }) => handle === 'news')?.id ?? null);
    expect(picker.selected).toBe('id-news');
  });
});

describe('past the cap', () => {
  const name = (n: number) => `c${String(n).padStart(3, '0')}`;

  test(`lists ${pickerMax} at most, keeping every follow and the chosen community first, and says it cut`, async () => {
    // 260 local communities, every tenth restricted, and 30 remote follows.
    core.local = Array.from({ length: 260 }, (_, n) => local(name(n), { postingRestrictedToMods: n % 10 === 0 }));
    core.follows = [
      follow(name(150), { host: 'feddit.test', local: true }),
      // Past the first page by name: fetched by id.
      follow(name(250), { host: 'feddit.test', local: true }),
      ...Array.from({ length: 30 }, (_, n) => follow(`r${n}`)),
    ];
    const picker = await pickerFor(person(), (rows) => rows.find(({ handle }) => handle === name(190))?.id ?? null);
    const handles = picker.communities.map(({ handle }) => handle);
    expect(handles).toHaveLength(pickerMax);
    expect(picker.truncated).toBe(true);
    // The follows and the chosen one (not followed) are kept; the other local ones fill the rest by name.
    for (const kept of [name(150), name(250), name(190), 'r0@lemmy.test', 'r29@lemmy.test']) expect(handles).toContain(kept);
    expect(picker.selected).toBe(`id-${name(190)}`);
    expect(handles).not.toContain(name(189));
    // The order is the picker's: local ones by name, then the remote follows.
    const localOnes = picker.communities.filter((row) => row.local).map(({ handle }) => handle);
    expect(localOnes).toEqual(localOnes.toSorted());
    expect(handles.slice(-30)).toEqual(Array.from({ length: 30 }, (_, n) => `r${n}@lemmy.test`));
    // The first page plus the follows it left out: two reads, and one moderator query for every restricted one kept.
    expect(core.listLocalCommunities).toHaveBeenCalledTimes(2);
    expect(core.listLocalCommunities.mock.calls[1]?.[0]).toMatchObject({ ids: [`id-${name(250)}`] });
    expect(core.moderatedAmong).toHaveBeenCalledTimes(1);
    expect(core.moderatedAmong.mock.calls[0]?.[1]).toEqual(picker.communities.filter((row) => row.restricted).map(({ id }) => id));
  });

  test('the community the form starts in survives the cut', async () => {
    core.local = Array.from({ length: 201 }, (_, n) => local(name(n)));
    const picker = await pickerFor(person(), () => `id-${name(200)}`);
    expect(picker.communities).toHaveLength(pickerMax);
    expect(picker.communities.map(({ handle }) => handle)).toContain(name(200));
    expect(picker.selected).toBe(`id-${name(200)}`);
  });

  test('more follows than the cap: the first by name, and the cut is said', async () => {
    core.follows = Array.from({ length: pickerMax + 5 }, (_, n) => follow(name(n)));
    const picker = await pickerFor(person(), none);
    expect(picker.communities).toHaveLength(pickerMax);
    expect(picker.truncated).toBe(true);
    expect(picker.communities.at(-1)?.handle).toBe(`${name(pickerMax - 1)}@lemmy.test`);
  });
});
