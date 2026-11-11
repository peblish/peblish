import type { CurrentSession } from '@peblish/core/identity/session';
import { beforeEach, expect, test, vi } from 'vitest';

// The security page's POST handler and its request contract (PR #26): each form's intent is its
// submit button's, a revoke form names its session in the address (?session=), and the handler
// reads the address under the body, which wins. Better-auth, the session store and the throttle
// are stubbed; the sessions below belong to two accounts, so a test can see whose session ended.

const mine = { userId: '019a0000-0000-7000-8000-0000000000a1', actorId: '019a0000-0000-7000-8000-0000000000a2' };
const theirs = { userId: '019a0000-0000-7000-8000-0000000000b1' };
const current = '019a0000-0000-7000-8000-0000000000a3';
const laptop = '019a0000-0000-7000-8000-0000000000a4';
const phone = '019a0000-0000-7000-8000-0000000000a5';
const stranger = '019a0000-0000-7000-8000-0000000000b4';

const sessions = vi.hoisted(() => new Map<string, string>());
const owners = () => Object.fromEntries([...sessions].sort());
const core = vi.hoisted(() => ({
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  disableTwoFactor: vi.fn(),
  changePasswordAs: vi.fn(),
  startTotpSetup: vi.fn(),
  confirmTotpSetup: vi.fn(),
}));
vi.mock('@peblish/core/identity/session', () => ({ revokeSession: core.revokeSession, deviceSessions: async () => [] }));
vi.mock('@peblish/core/identity/auth', () => ({
  auth: async () => ({ api: { disableTwoFactor: core.disableTwoFactor, revokeOtherSessions: core.revokeOtherSessions } }),
  authErrorCode: (error: unknown) => (error instanceof Error && error.message.startsWith('auth:') ? error.message.slice(5) : undefined),
}));
vi.mock('@peblish/core/identity/two-factor', () => ({
  changePasswordAs: core.changePasswordAs,
  startTotpSetup: core.startTotpSetup,
  confirmTotpSetup: core.confirmTotpSetup,
  pendingTotp: async () => null,
  takeRecoveryCodes: async () => null,
}));
vi.mock('@peblish/core/identity/throttle', () => ({ attempt: async () => ({ allowed: true, refund: async () => {} }) }));
vi.mock('@peblish/core/identity/handles', () => ({ localHandles: async () => ({ host: 'disc.test' }) }));
const signedIn = vi.hoisted(() => ({ session: null as CurrentSession | null }));
vi.mock('../../../server/auth.ts', async (original) => {
  const real = await original<typeof import('../../../server/auth.ts')>();
  return {
    ...real,
    formSession: async (request: Request) => real.withSession(request, signedIn.session),
    clientIp: () => '203.0.113.9',
    forwardedHeaders: () => new Headers(),
  };
});
const { Route } = await import('./index.tsx');

const handlers = Route.options.server?.handlers;
const handlePost = typeof handlers === 'object' && handlers && 'POST' in handlers ? handlers.POST : undefined;
if (typeof handlePost !== 'function') throw new Error('the security route has no POST handler');
const handle = handlePost;

beforeEach(() => {
  sessions.clear();
  for (const id of [current, laptop, phone]) sessions.set(id, mine.userId);
  sessions.set(stranger, theirs.userId);
  signedIn.session = {
    view: { ...mine, name: 'mira', displayName: null, siteRole: 'user', emailVerified: true, twoFactorEnabled: true, ageDeclaredAt: null },
    sessionId: current,
    email: 'mira@example.test',
    role: 'user',
    sessionCreatedAt: new Date(),
    setCookies: [],
  };
  // As core's revokeSession: only a session of the given account ends.
  core.revokeSession
    .mockReset()
    .mockImplementation(async (userId: string, id: string) => sessions.get(id) === userId && sessions.delete(id));
  core.revokeOtherSessions.mockReset().mockImplementation(async () => {
    for (const [id, owner] of sessions) if (owner === mine.userId && id !== current) sessions.delete(id);
  });
  core.disableTwoFactor.mockReset().mockResolvedValue({ headers: new Headers() });
  core.changePasswordAs.mockReset().mockResolvedValue([]);
  core.startTotpSetup.mockReset().mockResolvedValue(undefined);
  core.confirmTotpSetup.mockReset().mockResolvedValue([]);
});

/** A post to /settings/security with `address` as its query and `body` as its form, from this site unless `origin` says otherwise. */
async function post(address: Record<string, string>, body: Record<string, string>, origin = 'https://disc.test'): Promise<Response> {
  const query = new URLSearchParams(address).toString();
  const url = `https://disc.test/settings/security${query ? `?${query}` : ''}`;
  const headers = new Headers({ host: 'disc.test', origin });
  const request = new Request(url, { method: 'POST', headers, body: new URLSearchParams(body) });
  // Only `request` is read; the router's other context fields do not matter here.
  const answer = await handle({ request } as Parameters<typeof handle>[0]);
  if (!(answer instanceof Response)) throw new Error('the handler did not answer with a Response');
  return answer;
}
const where = (response: Response) => [response.status, response.headers.get('location')];
const calls = () =>
  Object.fromEntries(
    Object.entries(core)
      .map(([name, fn]) => [name, fn.mock.calls.length])
      .filter(([, count]) => count !== 0),
  );

test('the body’s intent wins over the address’s', async () => {
  // A revoke form's address with a password form's body: the password changes, no session ends.
  const answer = await post({ intent: 'revoke', session: laptop }, { intent: 'password', current: 'old', next: 'a new long password' });
  expect(where(answer)).toEqual([303, '/settings/security?saved=password']);
  expect(calls()).toEqual({ changePasswordAs: 1 });
  // Two-factor off in the address, revoke in the body: only the session ends.
  await post({ intent: 'totp-off', password: 'x' }, { intent: 'revoke', session: laptop });
  expect(calls()).toEqual({ changePasswordAs: 1, revokeSession: 1 });
  expect(core.disableTwoFactor).not.toHaveBeenCalled();
  expect(owners()).toEqual({ [current]: mine.userId, [phone]: mine.userId, [stranger]: theirs.userId });
});

test('the body’s session id wins over the address’s, in both directions, and only ever as the signed-in account', async () => {
  await post({ session: laptop }, { intent: 'revoke', session: phone });
  expect(Object.keys(owners())).toEqual([laptop, current, stranger].sort());
  await post({ session: phone }, { intent: 'revoke', session: laptop });
  expect(Object.keys(owners())).toEqual([current, stranger].sort());
  expect(core.revokeSession.mock.calls).toEqual([
    [mine.userId, phone],
    [mine.userId, laptop],
  ]);
});

test('another account’s session cannot be revoked from here, whichever field names it', async () => {
  for (const [address, body] of [
    [{ session: stranger }, { intent: 'revoke' }],
    [{ session: laptop }, { intent: 'revoke', session: stranger }],
    [
      { session: stranger, userId: theirs.userId },
      { intent: 'revoke', userId: theirs.userId },
    ],
  ] as const) {
    const answer = await post(address, body);
    // Nothing to report: the page comes back as it would for a session that already ended.
    expect([address, ...where(answer)]).toEqual([address, 303, '/settings/security']);
  }
  expect(core.revokeSession.mock.calls.every(([userId]) => userId === mine.userId)).toBe(true);
  expect(owners()).toEqual({ [current]: mine.userId, [laptop]: mine.userId, [phone]: mine.userId, [stranger]: theirs.userId });
});

test('a missing or unknown intent, or a revoke without a session id, is refused and changes nothing', async () => {
  const refused = [303, '/settings/security?error=form.invalid'];
  for (const [address, body] of [
    [{}, { password: 'x' }],
    [{ session: laptop }, {}],
    [{ intent: 'delete' }, { password: 'x' }],
    [{ intent: 'revoke', session: laptop }, { intent: 'revoke-all' }],
    [{ intent: 'revoke' }, {}],
    [{ intent: 'revoke', session: 'not-a-uuid' }, {}],
    [{ intent: 'password' }, { current: 'only one of the two' }],
  ] as const) {
    expect([address, body, ...where(await post(address, body))]).toEqual([address, body, ...refused]);
  }
  expect(calls()).toEqual({});
  expect(Object.keys(owners())).toHaveLength(4);
});

test('a cross-origin post is refused before anything is read, even with every field in the address', async () => {
  const addresses: Record<string, string>[] = [
    { intent: 'revoke', session: laptop },
    { intent: 'revoke-others' },
    { intent: 'totp-off', password: 'x' },
  ];
  for (const address of addresses) {
    for (const origin of ['https://evil.example', 'null'])
      expect([address, origin, (await post(address, {}, origin)).status]).toEqual([address, origin, 403]);
  }
  expect(calls()).toEqual({});
  expect(Object.keys(owners())).toHaveLength(4);
});

test('the redirect stays on the security page whatever the address says', async () => {
  const hostile = { redirect: 'https://evil.example/', back: '//evil.example/', next: '/elsewhere', form: 'x', error: 'y' };
  const outcomes = [
    await post(hostile, { intent: 'revoke', session: laptop }),
    await post(hostile, { intent: 'revoke-others' }),
    await post(hostile, { intent: 'totp-off', password: 'right' }),
    await post(hostile, { intent: 'totp-start', password: 'right' }),
    await post(hostile, { intent: 'totp-verify', code: '123 456' }),
    await post(hostile, { intent: 'password', current: 'right', next: 'a new long password' }),
    await post(hostile, { intent: 'nothing' }),
  ];
  expect(outcomes.map((answer) => answer.headers.get('location'))).toEqual([
    '/settings/security',
    '/settings/security',
    '/settings/security',
    '/settings/security',
    '/settings/security',
    '/settings/security?saved=password',
    '/settings/security?error=form.invalid',
  ]);
  // A refusal from better-auth comes back to the page too, naming the form it belongs to.
  core.disableTwoFactor.mockRejectedValueOnce(new Error('auth:INVALID_PASSWORD'));
  expect(where(await post(hostile, { intent: 'totp-off', password: 'wrong' }))).toEqual([
    303,
    '/settings/security?error=password.wrong&form=totp-off',
  ]);
  signedIn.session = null;
  expect(where(await post(hostile, { intent: 'revoke-others' }))).toEqual([303, '/auth/sign-in?redirect=%2Fsettings%2Fsecurity']);
});
