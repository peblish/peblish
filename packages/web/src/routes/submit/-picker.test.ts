import type { SessionView } from '@peblish/schema/session';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// The composer's community picker (pickerFor), with core's reads stubbed: local communities by
// name, the person's follows, which of a list the person moderates, one community by id, and
// post.create's precheck (bans, mods-only, the age gate) for the community the form starts in.

type Local = {
  actor: { id: string; handle: string; displayName: string | null; local: boolean };
  postingRestrictedToMods: boolean;
  subscribers: number;
  sensitive: boolean;
  nsfl: boolean;
};
type Follow = {
  id: string;
  name: string;
  displayName: string | null;
  host: string;
  local: boolean;
  state: 'accepted' | 'pending';
  postingRestrictedToMods: boolean;
  sensitive: boolean;
  nsfl: boolean;
};

const core = vi.hoisted(() => ({
  local: [] as Local[],
  /** Remote communities this server holds, followed or not. */
  remote: [] as Local[],
  follows: [] as Follow[],
  staffOf: new Set<string>(),
  bannedFrom: new Set<string>(),
  /** Communities on a host this server or the person blocks. */
  hostBlocked: new Set<string>(),
  listLocalCommunities: vi.fn(),
  moderatedAmong: vi.fn(),
  followedCommunities: vi.fn(),
  readCommunity: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock('@peblish/core/communities/read', () => ({
  listLocalCommunities: core.listLocalCommunities,
  moderatedAmong: core.moderatedAmong,
  readCommunity: core.readCommunity,
  hostBlockedFor: async (_viewerId: string, id: string) => core.hostBlocked.has(id),
  // As core's: a local name in any case, or name@host for a remote one; removed or gated or not.
  findCommunityId: async (handle: string) =>
    [...core.local, ...core.remote].find(({ actor }) => actor.handle === handle.toLowerCase())?.actor.id ?? null,
}));
vi.mock('@peblish/core/follows/read', () => ({ followedCommunities: core.followedCommunities }));
vi.mock('@peblish/core/authz/authorize', () => ({ authorize: core.authorize }));
const { pickerFor, pickerMax } = await import('./-picker.ts');

const local = (name: string, extra: Partial<Local> = {}): Local => ({
  actor: { id: `id-${name}`, handle: name, displayName: `${name} in full`, local: true },
  postingRestrictedToMods: false,
  subscribers: 3,
  sensitive: false,
  nsfl: false,
  ...extra,
});
const follow = (name: string, extra: Partial<Follow> = {}): Follow => ({
  id: `id-${name}`,
  name,
  displayName: null,
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
  core.remote = [];
  core.follows = [];
  core.staffOf = new Set();
  core.bannedFrom = new Set();
  core.hostBlocked = new Set();
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
  core.followedCommunities
    .mockReset()
    .mockImplementation(async (_actorId: string, options: { accepted?: boolean; includeSensitive?: boolean; limit?: number } = {}) =>
      core.follows
        .filter((row) => !options.accepted || row.state === 'accepted')
        .filter((row) => options.includeSensitive !== false || !(row.sensitive || row.nsfl))
        .slice(0, options.limit),
    );
  core.readCommunity.mockReset().mockImplementation(async ({ id }: { id: string }) => {
    const row = [...core.local, ...core.remote].find(({ actor }) => actor.id === id);
    return row && { ...row, actor: { ...row.actor } };
  });
  // post.create's precheck as it reads here: a ban, then mods-only for anyone but staff, then the age gate.
  core.authorize
    .mockReset()
    .mockImplementation(async (_action: string, principal: { siteRole: string }, { communityId }: { communityId: string }) => {
      const row = [...core.local, ...core.remote].find(({ actor }) => actor.id === communityId);
      if (!row) return { ok: false, reason: 'target.not_found' };
      if (core.bannedFrom.has(communityId)) return { ok: false, reason: 'community.banned' };
      if (row.postingRestrictedToMods && principal.siteRole !== 'admin' && !core.staffOf.has(communityId))
        return { ok: false, reason: 'mod.moderator_required' };
      if (row.sensitive || row.nsfl) return { ok: false, reason: 'age.declaration_required' };
      return { ok: true };
    });
});

/** Where the form starts: nothing asked for, or the keys in `wanted`, in order. */
const start = (...wanted: string[]) => ({ edit: null, wanted });

describe('a person with a handful of follows', () => {
  test('sees every local community by name, then the remote ones they follow, as before, with one moderator query', async () => {
    core.local = [local('art'), local('notices', { postingRestrictedToMods: true }), local('news'), local('adults', { sensitive: true })];
    core.follows = [
      follow('news', { host: 'feddit.test', local: true }),
      follow('technology', { displayName: 'Technology' }),
      follow('announcements', { postingRestrictedToMods: true }),
      follow('pending', { state: 'pending' }),
      follow('nsfw', { sensitive: true }),
    ];
    core.staffOf = new Set(['id-announcements']);
    const picker = await pickerFor(person(), start());
    expect(picker.communities).toEqual([
      { id: 'id-art', handle: 'art', displayName: 'art in full', local: true, subscribers: 3, restricted: false, canPost: true },
      {
        id: 'id-notices',
        handle: 'notices',
        displayName: 'notices in full',
        local: true,
        subscribers: 3,
        restricted: true,
        canPost: false,
      },
      { id: 'id-news', handle: 'news', displayName: 'news in full', local: true, subscribers: 3, restricted: false, canPost: true },
      {
        id: 'id-technology',
        handle: 'technology@lemmy.test',
        displayName: 'Technology',
        local: false,
        subscribers: null,
        restricted: false,
        canPost: true,
      },
      {
        id: 'id-announcements',
        handle: 'announcements@lemmy.test',
        displayName: null,
        local: false,
        subscribers: null,
        restricted: true,
        canPost: true,
      },
    ]);
    expect(picker.truncated).toBe(false);
    expect(core.moderatedAmong.mock.calls).toEqual([['me', ['id-notices', 'id-announcements']]]);
    expect(core.listLocalCommunities).toHaveBeenCalledTimes(1);
    // Accepted follows past the age gate, the first by name, one past the cap: read as the local ones are.
    expect(core.followedCommunities.mock.calls).toEqual([['me', { accepted: true, includeSensitive: false, limit: pickerMax + 1 }]]);
  });

  test('a site admin posts anywhere and asks nothing about moderators', async () => {
    core.local = [local('notices', { postingRestrictedToMods: true })];
    const picker = await pickerFor(person({ siteRole: 'admin' }), start());
    expect(picker.communities.map(({ canPost }) => canPost)).toEqual([true]);
    expect(core.moderatedAmong.mock.calls).toEqual([['me', []]]);
  });

  test('the community the form starts in is chosen from what the picker lists', async () => {
    core.local = [local('art'), local('news')];
    expect((await pickerFor(person(), start('news'))).selected).toBe('id-news');
    expect(core.readCommunity).not.toHaveBeenCalled();
  });
});

describe('the community the form starts in', () => {
  test('is only one the person may post in, wherever it ranks: not where they are banned, nor mods-only unless staff', async () => {
    core.local = [local('art'), local('news'), local('notices', { postingRestrictedToMods: true })];
    core.bannedFrom = new Set(['id-news']);
    expect((await pickerFor(person(), start('news'))).selected).toBeNull();
    expect((await pickerFor(person(), start('notices'))).selected).toBeNull();
    // The next key the form names is tried in turn.
    expect((await pickerFor(person(), start('news', 'art'))).selected).toBe('id-art');
    core.staffOf = new Set(['id-notices']);
    expect((await pickerFor(person(), start('notices'))).selected).toBe('id-notices');
    // The community is still listed, as before: only the start is refused.
    expect((await pickerFor(person(), start('news'))).communities.map(({ handle }) => handle)).toContain('news');
  });

  test('a refusal about the person, not the community, does not stop it', async () => {
    core.local = [local('art')];
    core.authorize.mockResolvedValue({ ok: false, reason: 'auth.email_unverified' });
    expect((await pickerFor(person({ emailVerified: false }), start('art'))).selected).toBe('id-art');
  });

  test('a remote community the person does not follow, where they may post, is looked up and listed', async () => {
    core.local = [local('art')];
    core.follows = [follow('tech')];
    core.remote = [
      { ...local('lab'), actor: { id: 'id-lab', handle: 'lab@lemmy.test', displayName: 'The Lab', local: false } },
      { ...local('closed'), actor: { id: 'id-closed', handle: 'closed@lemmy.test', displayName: null, local: false } },
    ];
    core.bannedFrom = new Set(['id-closed']);
    const picker = await pickerFor(person(), start('lab@lemmy.test'));
    expect(picker.selected).toBe('id-lab');
    expect(picker.communities.find(({ id }) => id === 'id-lab')).toEqual({
      id: 'id-lab',
      handle: 'lab@lemmy.test',
      displayName: 'The Lab',
      local: false,
      subscribers: null,
      restricted: false,
      canPost: true,
    });
    expect((await pickerFor(person(), start('!closed@lemmy.test'))).selected).toBeNull();
  });

  test('a remote community on a host this server or the person blocks is not looked up', async () => {
    core.local = [local('art')];
    core.remote = [{ ...local('walled'), actor: { id: 'id-walled', handle: 'walled@shut.test', displayName: null, local: false } }];
    core.hostBlocked = new Set(['id-walled']);
    const picker = await pickerFor(person(), start('walled@shut.test', 'art'));
    expect(picker.selected).toBe('id-art');
    expect(picker.communities.map(({ handle }) => handle)).toEqual(['art']);
  });

  test("an edit starts in the post's own community, without asking", async () => {
    core.local = [local('art'), local('news')];
    core.bannedFrom = new Set(['id-news']);
    expect((await pickerFor(person(), { edit: 'id-news', wanted: ['art'] })).selected).toBe('id-news');
    expect(core.authorize).not.toHaveBeenCalled();
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
    const picker = await pickerFor(person(), start(name(191)));
    const handles = picker.communities.map(({ handle }) => handle);
    expect(handles).toHaveLength(pickerMax);
    expect(picker.truncated).toBe(true);
    // The follows and the chosen one (not followed) are kept; the other local ones fill the rest by name.
    for (const kept of [name(150), name(250), name(191), 'r0@lemmy.test', 'r29@lemmy.test']) expect(handles).toContain(kept);
    expect(picker.selected).toBe(`id-${name(191)}`);
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
    const picker = await pickerFor(person(), start(`id-${name(200)}`));
    expect(picker.communities).toHaveLength(pickerMax);
    expect(picker.communities.map(({ handle }) => handle)).toContain(name(200));
    expect(picker.selected).toBe(`id-${name(200)}`);
  });

  test('a community asked for by name or id past the first page is looked up on its own, where the person may post', async () => {
    core.local = Array.from({ length: 260 }, (_, n) =>
      local(name(n), { postingRestrictedToMods: n === 240 || n === 241, sensitive: n === 230 }),
    );
    core.staffOf = new Set([`id-${name(241)}`]);
    const ask = (wanted: string) => pickerFor(person(), start(wanted));
    for (const wanted of [name(250), `!${name(250).toUpperCase()}`]) {
      const picker = await ask(wanted);
      expect([wanted, picker.selected]).toEqual([wanted, `id-${name(250)}`]);
      const handles = picker.communities.map(({ handle }) => handle);
      expect(handles).toHaveLength(pickerMax);
      expect(handles).toContain(name(250));
      // In its place by name, after the first page's.
      expect(handles).toEqual(handles.toSorted());
    }
    expect(core.readCommunity).toHaveBeenLastCalledWith({ id: `id-${name(250)}` });
    // Not where they may not post: mods-only without being staff there, or age-gated for them.
    expect((await ask(name(240))).selected).toBeNull();
    expect((await ask(name(241))).selected).toBe(`id-${name(241)}`);
    expect((await ask(name(230))).selected).toBeNull();
    expect((await ask('nowhere')).selected).toBeNull();
    // By id, as a link from the community's page names it.
    const id = '019a0000-0000-7000-8000-0000000000ff';
    core.local.push({ ...local('zz'), actor: { id, handle: 'zz', displayName: null, local: true } });
    expect((await ask(id)).selected).toBe(id);
    // What the list already holds is chosen from it, with no further read.
    core.readCommunity.mockClear();
    expect((await pickerFor(person(), start(name(3), name(250)))).selected).toBe(`id-${name(3)}`);
    expect(core.readCommunity).not.toHaveBeenCalled();
  });

  test('follows past the first page are read at most a cap at a time', async () => {
    core.local = Array.from({ length: 900 }, (_, n) => local(name(n)));
    core.follows = Array.from({ length: 600 }, (_, n) => follow(name(300 + n), { host: 'feddit.test', local: true }));
    const picker = await pickerFor(person(), start());
    expect(picker.communities).toHaveLength(pickerMax);
    const ids = core.listLocalCommunities.mock.calls[1]?.[0]?.ids as string[];
    expect(ids).toHaveLength(pickerMax);
    // The first by name: the ones the cap keeps.
    expect(ids[0]).toBe(`id-${name(300)}`);
  });

  test('more follows than the cap: the first by name, and the cut is said', async () => {
    core.follows = Array.from({ length: pickerMax + 5 }, (_, n) => follow(name(n)));
    const picker = await pickerFor(person(), start());
    expect(picker.communities).toHaveLength(pickerMax);
    expect(picker.truncated).toBe(true);
    expect(picker.communities.at(-1)?.handle).toBe(`${name(pickerMax - 1)}@lemmy.test`);
  });
});
