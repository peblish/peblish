import type { BlockTarget } from '@peblish/core/blocks/actions';
import type { CurrentSession } from '@peblish/core/identity/session';
import type { Principal } from '@peblish/schema/authz';
import { beforeEach, expect, test, vi } from 'vitest';

// The POST handler's request contract (PR #26): a form's fixed fields come in its address and
// what was typed in the body, which wins. The session and the core calls are stubbed; the block
// store below is keyed by the blocker, as core's tables are, so a test can see whose block changed.

const viewer = { userId: '019a0000-0000-7000-8000-0000000000a1', actorId: '019a0000-0000-7000-8000-0000000000a2' };
const other = { actorId: '019a0000-0000-7000-8000-0000000000b2' };
const noisy = '019a0000-0000-7000-8000-0000000000c1';
const quiet = '019a0000-0000-7000-8000-0000000000c2';

const store = vi.hoisted(() => new Map<string, Set<string>>());
const idOf = (target: BlockTarget) => (target.kind === 'instance' ? target.instanceId : target.actorId);
const blockerOf = (principal: Principal) => (principal.kind === 'local' ? principal.actorId : 'nobody');
const blocksOf = (actorId: string) => [...(store.get(actorId) ?? [])].sort();

const actions = vi.hoisted(() => ({
  addBlockAs: vi.fn(),
  removeBlockAs: vi.fn(),
  resolveBlockTarget: vi.fn(),
}));
vi.mock('@peblish/core/blocks/actions', () => actions);
vi.mock('@peblish/core/config', () => ({ publicOrigin: () => 'https://disc.test' }));
const signedIn = vi.hoisted(() => ({ session: null as CurrentSession | null }));
vi.mock('../../../server/auth.ts', async (original) => {
  const real = await original<typeof import('../../../server/auth.ts')>();
  return { ...real, formSession: async (request: Request) => real.withSession(request, signedIn.session) };
});
const { handleBlocksPost } = await import('./-post.ts');

beforeEach(() => {
  store.clear();
  store.set(other.actorId, new Set([noisy]));
  signedIn.session = {
    view: {
      ...viewer,
      name: 'mira',
      displayName: null,
      siteRole: 'user',
      emailVerified: true,
      twoFactorEnabled: false,
      ageDeclaredAt: null,
    },
    sessionId: '019a0000-0000-7000-8000-0000000000a3',
    email: 'mira@example.test',
    role: 'user',
    sessionCreatedAt: new Date(),
    setCookies: [],
  };
  actions.addBlockAs.mockReset().mockImplementation(async (principal: Principal, target: BlockTarget) => {
    const own = store.get(blockerOf(principal)) ?? new Set();
    store.set(blockerOf(principal), own.add(idOf(target)));
    return { ok: true, created: true, unfollowed: 0 };
  });
  actions.removeBlockAs.mockReset().mockImplementation(async (principal: Principal, target: BlockTarget) => {
    const removed = store.get(blockerOf(principal))?.delete(idOf(target)) ?? false;
    return { ok: true, removed };
  });
  actions.resolveBlockTarget.mockReset().mockResolvedValue({ ok: true, target: { kind: 'person', actorId: quiet } });
});

/** A post to /settings/blocks with `address` as its query and `body` as its form, from this site unless `origin` says otherwise. */
function post(address: Record<string, string>, body: Record<string, string>, options: { origin?: string; json?: boolean } = {}) {
  const headers = new Headers({ host: 'disc.test', origin: options.origin ?? 'https://disc.test' });
  if (options.json) headers.set('accept', 'application/json');
  const url = `https://disc.test/settings/blocks?${new URLSearchParams(address)}`;
  return handleBlocksPost(new Request(url, { method: 'POST', headers, body: new URLSearchParams(body) }));
}
const where = (response: Response) => [response.status, response.headers.get('location')];

test('the body wins over the address: an intent in both is the body’s', async () => {
  store.set(viewer.actorId, new Set([noisy]));
  // The address says add, the body says remove: the block is lifted.
  expect(where(await post({ intent: 'add', kind: 'person', target: noisy }, { intent: 'remove' }))).toEqual([
    303,
    '/settings/blocks?tab=people',
  ]);
  expect(blocksOf(viewer.actorId)).toEqual([]);
  // And the other way round.
  await post({ intent: 'remove', kind: 'person', target: noisy }, { intent: 'add' });
  expect(blocksOf(viewer.actorId)).toEqual([noisy]);
  expect(actions.addBlockAs).toHaveBeenCalledTimes(1);
  expect(actions.removeBlockAs).toHaveBeenCalledTimes(1);
});

test('the body wins over the address for the target, in both directions, and only the signed-in account’s blocks change', async () => {
  await post({ intent: 'add', kind: 'person', target: noisy }, { target: quiet });
  expect(blocksOf(viewer.actorId)).toEqual([quiet]);
  await post({ intent: 'add', kind: 'person', target: quiet }, { target: noisy });
  expect(blocksOf(viewer.actorId)).toEqual([noisy, quiet].sort());
  // Every call acted as the session's own principal; the other account's block never moved.
  for (const [principal] of actions.addBlockAs.mock.calls)
    expect(principal).toEqual({ kind: 'local', actorId: viewer.actorId, siteRole: 'user' });
  expect(blocksOf(other.actorId)).toEqual([noisy]);
});

test('a block another account holds cannot be lifted from here: unblocking the same target only touches your own list', async () => {
  // Fields naming the other account are not read: the principal comes from the session only.
  const answer = await post({ intent: 'remove', kind: 'person', target: noisy, blocker: other.actorId, actorId: other.actorId }, {});
  expect(where(answer)).toEqual([303, '/settings/blocks?tab=people']);
  expect(actions.removeBlockAs).toHaveBeenCalledWith(
    { kind: 'local', actorId: viewer.actorId, siteRole: 'user' },
    { kind: 'person', actorId: noisy },
  );
  expect(blocksOf(other.actorId)).toEqual([noisy]);
  expect(blocksOf(viewer.actorId)).toEqual([]);
});

test('a missing or unknown intent, or a target that is not an id, is refused and changes nothing', async () => {
  const refused = ['/settings/blocks?tab=people&error=form.invalid'];
  for (const [address, body] of [
    [{ kind: 'person', target: noisy }, {}],
    [{ intent: 'mute', kind: 'person', target: noisy }, {}],
    [{ intent: 'add', kind: 'person', target: noisy }, { intent: 'delete' }],
    [{ intent: 'add', kind: 'person' }, { target: 'not-a-uuid' }],
    [{ intent: 'add', kind: 'robot', target: noisy }, {}],
  ] as const) {
    const answer = await post(address, body);
    expect([address, body, ...where(answer).slice(1)]).toEqual([address, body, ...refused]);
  }
  // Remove with no target has nothing to name.
  expect(where(await post({ intent: 'remove', kind: 'person' }, {}))).toEqual([303, '/settings/blocks?tab=people&error=form.invalid']);
  expect(await (await post({ kind: 'person' }, {}, { json: true })).json()).toEqual({ error: 'form.invalid' });
  expect(actions.addBlockAs).not.toHaveBeenCalled();
  expect(actions.removeBlockAs).not.toHaveBeenCalled();
  expect(actions.resolveBlockTarget).not.toHaveBeenCalled();
});

test('a cross-origin post is refused before anything is read, even with every field in the address', async () => {
  for (const origin of ['https://evil.example', 'null']) {
    const answer = await post({ intent: 'add', kind: 'person', target: noisy, back: '/' }, {}, { origin });
    expect([origin, answer.status]).toEqual([origin, 403]);
  }
  expect(actions.addBlockAs).not.toHaveBeenCalled();
  expect(blocksOf(viewer.actorId)).toEqual([]);
});

test('the redirect stays on this site, and under /settings without a slot’s own page, whatever the address says', async () => {
  const add = { intent: 'add', kind: 'person', target: noisy };
  // No `back`: the tab of what changed, with nothing else from the address.
  const plain = await post({ ...add, tab: 'instances', redirect: 'https://evil.example/', error: 'x' }, {});
  expect(where(plain)).toEqual([303, `/settings/blocks?tab=people&just=${noisy}`]);
  // A slot's `back` is a page of this site; one that leaves it is refused.
  expect(where(await post({ ...add, back: '/post/1#c2' }, {}))).toEqual([303, '/post/1#c2']);
  for (const back of ['https://evil.example/', '//evil.example/', '/\\evil.example', '/\t/evil.example', 'javascript:alert(1)']) {
    const location = (await post({ ...add, back }, {})).headers.get('location') ?? '';
    expect([back, new URL(location, 'https://disc.test').origin]).toEqual([back, 'https://disc.test']);
  }
  // A body `back` wins over the address's, and is checked the same way.
  expect(where(await post({ ...add, back: '/post/1' }, { back: '//evil.example/' }))).toEqual([303, '/']);
  // A refusal always goes back to the blocks page, never to `back`.
  actions.addBlockAs.mockResolvedValueOnce({ ok: false, reason: 'block.limit' });
  expect(where(await post({ ...add, back: '/post/1' }, {}))).toEqual([303, '/settings/blocks?tab=people&error=block.limit']);
  // Signed out: to sign in and back to the blocks page.
  signedIn.session = null;
  expect(where(await post({ ...add, back: 'https://evil.example/' }, {}))).toEqual([303, '/auth/sign-in?redirect=%2Fsettings%2Fblocks']);
});
