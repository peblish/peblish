import type { ActingPrincipal } from '@peblish/schema/authz';
import type { SessionView } from '@peblish/schema/session';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Deps, Submission } from './-submit.ts';

// The composer's community picker (pickerFor), with core's reads stubbed: local communities by
// name, the person's follows, which of a list the person moderates, and one community on its own
// as the composer may show it (composerCommunity: one the person could see, whether or not they
// may post there).

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
  /** Communities the directory's block rules hide from the person. */
  blocked: new Set<string>(),
  /** Communities that ban the person: composerCommunity does not ask, post.create refuses (submitDeps). */
  bannedFrom: new Set<string>(),
  listLocalCommunities: vi.fn(),
  moderatedAmong: vi.fn(),
  followedCommunities: vi.fn(),
  composerCommunity: vi.fn(),
}));
vi.mock('@peblish/core/communities/read', () => ({
  listLocalCommunities: core.listLocalCommunities,
  moderatedAmong: core.moderatedAmong,
}));
vi.mock('@peblish/core/follows/read', () => ({ followedCommunities: core.followedCommunities }));
vi.mock('@peblish/core/communities/start', () => ({ composerCommunity: core.composerCommunity }));
const { pickerFor, pickerMax } = await import('./-picker.ts');
const { parseSubmission, submit } = await import('./-submit.ts');

/**
 * The submit's calls for a text post: core's post.create, which refuses a member the community
 * bans (authz/role-table.test.ts), stood in for by `core.bannedFrom`; the post is then created.
 */
const submitDeps: Deps = {
  precheck: async (_principal, target) => ('communityId' in target && core.bannedFrom.has(target.communityId) ? 'community.banned' : null),
  throttle: async () => true,
  preview: async () => {
    throw new Error('a text post fetches no preview');
  },
  upload: async () => {
    throw new Error('a text post uploads nothing');
  },
  origin: async () => 'https://feddit.test',
  current: async () => null,
  createPost: async () => ({ ok: true, id: 'p1', apId: 'https://feddit.test/p1' }),
  updatePost: async () => {
    throw new Error('not an edit');
  },
};
const principal: ActingPrincipal = { kind: 'local', actorId: '0192f5a0-1234-7abc-8def-0123456789aa', siteRole: 'user' };
/** A text post in `community`, submitted as the form posts it. */
const postIn = (community: string) =>
  submit(
    { principal, viewer: { actorId: principal.actorId, siteRole: 'user' }, ip: null },
    parseSubmission({ community, title: 'Hello' }, null) as Submission,
    submitDeps,
  );

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
  core.blocked = new Set();
  core.bannedFrom = new Set();
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
  // Core's rule, which communities/start.test.ts tests through the real readers: a known community
  // by id or handle (a local name in any case, name@host for a remote one), past the age gate and
  // not blocked; whether the person may post there is not asked.
  core.composerCommunity.mockReset().mockImplementation(async (viewer: { declared: boolean }, key: string) => {
    const wanted = key.trim().replace(/^!/, '').toLowerCase();
    const row = [...core.local, ...core.remote].find(({ actor }) => actor.id === wanted || actor.handle === wanted);
    if (!row || core.blocked.has(row.actor.id) || (!viewer.declared && (row.sensitive || row.nsfl))) return null;
    return { ...row, actor: { ...row.actor } };
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

  test('asks core to leave out the local communities the person blocks', async () => {
    core.local = Array.from({ length: 202 }, (_, n) => local(`c${String(n).padStart(3, '0')}`));
    core.follows = [follow('c201', { host: 'feddit.test', local: true })];
    await pickerFor(person(), start());
    expect(core.listLocalCommunities.mock.calls.map(([options]) => options.hiddenFrom)).toEqual(['me', 'me']);
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
    expect(core.composerCommunity).not.toHaveBeenCalled();
  });
});

describe('the community the form starts in', () => {
  test('is any one the person could see, whether or not they may post there: a mods-only one starts, marked so', async () => {
    core.local = [local('art'), local('news'), local('notices', { postingRestrictedToMods: true })];
    const notices = await pickerFor(person(), start('notices'));
    expect(notices.selected).toBe('id-notices');
    expect(notices.communities.find(({ id }) => id === 'id-notices')?.canPost).toBe(false);
    // An unverified person starts there too: the form says why they cannot post.
    expect((await pickerFor(person({ emailVerified: false }), start('news'))).selected).toBe('id-news');
    // One they could not see (age-gated, for someone who has not declared 16+) is skipped, and the next key is tried in turn.
    core.local.push(local('adults', { sensitive: true }));
    expect((await pickerFor(person(), start('adults', 'art'))).selected).toBe('id-art');
  });

  test('a remote community the person does not follow is looked up and listed, one that bans them too', async () => {
    const lab = '0192f5a0-0000-7000-8000-00000000001a';
    const closed = '0192f5a0-0000-7000-8000-00000000001c';
    core.local = [local('art')];
    core.follows = [follow('tech')];
    core.remote = [
      { ...local('lab'), actor: { id: lab, handle: 'lab@lemmy.test', displayName: 'The Lab', local: false } },
      { ...local('closed'), actor: { id: closed, handle: 'closed@lemmy.test', displayName: null, local: false } },
    ];
    core.bannedFrom = new Set([closed]);
    const picker = await pickerFor(person(), start('lab@lemmy.test'));
    expect(picker.selected).toBe(lab);
    expect(picker.communities.find(({ id }) => id === lab)).toEqual({
      id: lab,
      handle: 'lab@lemmy.test',
      displayName: 'The Lab',
      local: false,
      subscribers: null,
      restricted: false,
      canPost: true,
    });
    expect(await postIn(lab)).toEqual({ ok: true, id: 'p1' });
    // A ban is the submit's refusal to give: the form starts there, and the post is refused by its reason.
    expect((await pickerFor(person(), start('!closed@lemmy.test'))).selected).toBe(closed);
    expect(await postIn(closed)).toEqual({ ok: false, error: 'community.banned' });
  });

  test('a community the person could not see, looked up on its own, leaves nothing of itself in the data', async () => {
    core.local = [local('art')];
    core.remote = [{ ...local('walled'), actor: { id: 'id-walled', handle: 'walled@shut.test', displayName: null, local: false } }];
    core.blocked = new Set(['id-walled']);
    const picker = await pickerFor(person(), start('walled@shut.test', 'art'));
    expect(picker.selected).toBe('id-art');
    expect(picker.communities.map(({ handle }) => handle)).toEqual(['art']);
  });

  test("an edit starts in the post's own community, without asking", async () => {
    core.local = [local('art'), local('news')];
    expect((await pickerFor(person(), { edit: 'id-news', wanted: ['art'] })).selected).toBe('id-news');
    expect(core.composerCommunity).not.toHaveBeenCalled();
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

  test('a community asked for by name or id past the first page is looked up on its own, where the person could see it', async () => {
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
    expect(core.composerCommunity).toHaveBeenLastCalledWith({ actorId: 'me', declared: false }, `!${name(250).toUpperCase()}`);
    // Mods-only starts, staff or not, and says whether they may post; age-gated for them, it is not there.
    const restricted = await ask(name(240));
    expect([restricted.selected, restricted.communities.find(({ id }) => id === `id-${name(240)}`)?.canPost]).toEqual([
      `id-${name(240)}`,
      false,
    ]);
    expect((await ask(name(241))).communities.find(({ id }) => id === `id-${name(241)}`)?.canPost).toBe(true);
    expect((await ask(name(230))).selected).toBeNull();
    expect((await ask('nowhere')).selected).toBeNull();
    // By id, as a link from the community's page names it.
    const id = '019a0000-0000-7000-8000-0000000000ff';
    core.local.push({ ...local('zz'), actor: { id, handle: 'zz', displayName: null, local: true } });
    expect((await ask(id)).selected).toBe(id);
    // What the list already holds is chosen from it, with no further read.
    core.composerCommunity.mockClear();
    expect((await pickerFor(person(), start(name(3), name(250)))).selected).toBe(`id-${name(3)}`);
    expect(core.composerCommunity).not.toHaveBeenCalled();
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
