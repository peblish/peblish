import type { CurrentSession } from '@peblish/core/identity/session';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { hostileReturns, ordinaryReturns } from './__fixtures__/return-addresses.ts';

// Every form handler that sends the browser on to an address the request names (`redirect`,
// `next`, `back`), driven with hostile and ordinary ones: the Location header and the JSON
// answer stay on this site, on success and on refusal. Better-auth, the session and the core
// calls are stubbed. The blocks page and the report pages have their own (blocks/-post.test.ts,
// reportBack is safeRedirect); sign-out, verification, reset, sign-up and the invite page only
// ever redirect to fixed paths.

const origin = 'https://feddit.test';
const api = vi.hoisted(() => ({ signInEmail: vi.fn(), verifyTOTP: vi.fn(), verifyBackupCode: vi.fn() }));
vi.mock('@peblish/core/identity/auth', () => ({
  auth: async () => ({ api, $context: Promise.resolve({ authCookies: { sessionToken: { attributes: { secure: true } } } }) }),
  authErrorCode: () => undefined,
}));
vi.mock('@peblish/core/identity/handles', () => ({
  localHandles: async () => ({ origin }),
  loginEmail: async () => 'mira@example.test',
}));
vi.mock('@peblish/core/identity/throttle', () => ({ attempt: async () => ({ allowed: true, refund: async () => {} }) }));
vi.mock('@peblish/core/communities/read', () => ({ findCommunityId: async () => '019a0000-0000-7000-8000-000000000001' }));
const follow = vi.hoisted(() => vi.fn());
vi.mock('@peblish/core/follows/service', () => ({ followAs: follow, unfollowAs: follow }));
const signedIn = vi.hoisted(() => ({ session: null as CurrentSession | null }));
vi.mock('./auth.ts', async (original) => {
  const real = await original<typeof import('./auth.ts')>();
  return {
    ...real,
    formSession: async (request: Request) => real.withSession(request, signedIn.session),
    clientIp: () => '203.0.113.9',
    forwardedHeaders: () => new Headers(),
  };
});
const { Route: signIn } = await import('../routes/auth/sign-in.tsx');
const { Route: twoFactor } = await import('../routes/auth/two-factor.tsx');
const { Route: join } = await import('../routes/communities/follow.ts');
const { Route: act } = await import('../routes/modlog/act.ts');
const { communityPost } = await import('../routes/c/-intents.ts');
const { Route: bans } = await import('../routes/admin/bans/index.tsx');

const mira: CurrentSession = {
  view: {
    userId: '019a0000-0000-7000-8000-0000000000a1',
    actorId: '019a0000-0000-7000-8000-0000000000a2',
    name: 'mira',
    displayName: null,
    siteRole: 'user',
    emailVerified: true,
    twoFactorEnabled: false,
    ageDeclaredAt: '2026-01-01T00:00:00.000Z',
  },
  sessionId: '019a0000-0000-7000-8000-0000000000a3',
  email: 'mira@example.test',
  role: 'user',
  sessionCreatedAt: new Date(),
  setCookies: [],
};

beforeEach(() => {
  signedIn.session = null;
  api.signInEmail.mockReset().mockResolvedValue({ headers: new Headers(), response: {} });
  api.verifyTOTP.mockReset().mockResolvedValue({ headers: new Headers() });
  follow.mockReset().mockResolvedValue({ ok: false, reason: 'community.banned' });
});

type Handler = (context: { request: Request }) => unknown;
/** A route's POST handler; only `request` is read, the router's other context fields do not matter here. */
function postOf(route: { options: { server?: { handlers?: unknown } } }): Handler {
  const handlers = route.options.server?.handlers;
  const handler = typeof handlers === 'object' && handlers && 'POST' in handlers ? handlers.POST : undefined;
  if (typeof handler !== 'function') throw new Error('the route has no POST handler');
  return handler as Handler;
}

function form(path: string, fields: Record<string, string>, json = false): Request {
  const headers = new Headers({ host: 'feddit.test', origin });
  if (json) headers.set('accept', 'application/json');
  return new Request(`${origin}${path}`, { method: 'POST', headers, body: new URLSearchParams(fields) });
}

/** Where a plain form's answer sends the browser: the 303's Location. */
function location(answer: unknown): string {
  if (!(answer instanceof Response)) throw new Error('the handler did not answer with a Response');
  expect(answer.status).toBe(303);
  return answer.headers.get('location')!;
}

/** What the enhanced form reads instead: the JSON answer's body, and no Location to follow. */
async function jsonBody(answer: unknown): Promise<Record<string, unknown>> {
  if (!(answer instanceof Response)) throw new Error('the handler did not answer with a Response');
  expect([answer.headers.get('content-type'), answer.headers.get('location')]).toEqual(['application/json', null]);
  return (await answer.json()) as Record<string, unknown>;
}

/**
 * The entry points, each sending `target` where it names its return address. `redirects` is
 * whether its JSON answer names a place to go (a success does); a refusal's names only the reason.
 */
const entries: [name: string, redirects: boolean, send: (target: string, json: boolean) => Promise<unknown>][] = [
  [
    'sign-in',
    true,
    (target, json) =>
      Promise.resolve(
        postOf(signIn)({ request: form('/auth/sign-in', { identifier: 'mira', password: 'x'.repeat(12), redirect: target }, json) }),
      ),
  ],
  [
    'two-factor',
    true,
    (target, json) =>
      Promise.resolve(postOf(twoFactor)({ request: form('/auth/two-factor', { code: '123456', method: 'totp', redirect: target }, json) })),
  ],
  // Refused (signed out): back to `next` with ?error=.
  [
    'community join',
    false,
    (target, json) =>
      Promise.resolve(postOf(join)({ request: form('/communities/follow', { community: 'x', intent: 'join', next: target }, json) })),
  ],
  // Refused (signed out): back to `back` with ?modError=.
  [
    'moderator form',
    false,
    (target, json) => Promise.resolve(postOf(act)({ request: form('/modlog/act', { intent: 'remove', back: target }, json) })),
  ],
  // Done (a Hide NSFW choice): to `redirect` as it is.
  ['NSFW choice', true, (target, json) => communityPost(form('/c/news', { intent: 'nsfw-once', redirect: target }, json), 'news')],
  // Refused (a follow a ban stops): back to `redirect` with ?error=.
  [
    'community follow',
    false,
    (target, json) => {
      signedIn.session = mira;
      return communityPost(form('/c/news', { intent: 'follow', redirect: target }, json), 'news');
    },
  ],
];

/** `to` is a path on this site, and nothing of the hostile address is kept as the path to go to. */
function onThisSite(to: string, target: string) {
  const url = new URL(to, origin);
  expect([target, url.origin, url.pathname.startsWith('//')]).toEqual([target, origin, false]);
  expect(url.pathname, target).not.toContain('evil.example');
}

describe.each(entries)('%s', (_, redirects, send) => {
  test.each(hostileReturns)('%s: stays on this site', async (_, target) => {
    onThisSite(location(await send(target, false)), target);
    const body = await jsonBody(await send(target, true));
    expect(['redirect' in body, target]).toEqual([redirects, target]);
    if (typeof body.redirect === 'string') onThisSite(body.redirect, target);
    expect(JSON.stringify(body), target).not.toContain('evil.example');
  });

  test.each(ordinaryReturns)('%s: kept, with its query and fragment', async (target) => {
    const url = new URL(location(await send(target, false)), origin);
    const wanted = new URL(target, origin);
    expect(url.pathname).toBe(wanted.pathname);
    // A refusal adds its error code to the query; everything the address had stays.
    for (const [name, value] of wanted.searchParams) expect(url.searchParams.get(name)).toBe(value);
    const body = await jsonBody(await send(target, true));
    if (redirects) expect(body.redirect).toBe(target);
  });
});

// Enter in a Bans panel field without scripts posts to the page itself, which only sends the
// browser back: to its own route, whatever path the request came in on.
test('the Bans tab goes back to itself, keeping the panel it came from', () => {
  const back = (path: string) => location(postOf(bans)({ request: form(path, {}) }));
  for (const path of ['//evil.example/admin/bans', '/.//evil.example/', '/%2F%2Fevil.example/admin/bans']) {
    expect(back(`${path}?modFor=site_unban:x`), path).toBe('/admin/bans?modFor=site_unban:x');
  }
  expect(back('/admin/bans/?lift=019a0000-0000-7000-8000-0000000000b1')).toBe('/admin/bans?lift=019a0000-0000-7000-8000-0000000000b1');
});

test('two-factor: the way from sign-in carries only a checked address', async () => {
  api.signInEmail.mockResolvedValue({ headers: new Headers(), response: { twoFactorRedirect: true } });
  const to = location(
    await postOf(signIn)({ request: form('/auth/sign-in', { identifier: 'mira', password: 'x', redirect: '/.//evil.example' }) }),
  );
  expect(to).toBe('/auth/two-factor?redirect=%2F');
});
