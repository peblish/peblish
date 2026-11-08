import { describe, expect, test } from 'vitest';
import { Route as adminGroup } from '../routes/admin/route.tsx';
import { Route as authGroup } from '../routes/auth/route.tsx';
import { Route as inviteGroup } from '../routes/invite/route.tsx';
import { Route as settingsGroup } from '../routes/settings/route.tsx';
import type { CurrentSession } from '@peblish/core/identity/session';
import { clientAddress, privateResponse, privateResponses, safeRedirect, sameOrigin, withSession } from './auth.ts';

const origin = 'https://feddit.test';

describe('safeRedirect keeps the visitor on this site', () => {
  test.each([
    ['tab', '/\t/attacker.example'],
    ['carriage return', '/\r/attacker.example'],
    ['line feed', '/\n/attacker.example'],
    ['delete', '/\x7f/attacker.example'],
    ['backslash', '/\\attacker.example'],
    ['protocol-relative', '//attacker.example'],
    ['absolute', 'https://attacker.example/'],
    ['relative', 'attacker.example'],
    ['empty', ''],
  ])('%s: home instead', (_, target) => expect(safeRedirect(target, origin)).toBe('/'));

  test('a path on this site, with its query and fragment', () => {
    expect(safeRedirect('/c/news?sort=new#top', origin)).toBe('/c/news?sort=new#top');
    expect(safeRedirect(undefined, origin)).toBe('/');
  });
});

describe('responses under /auth, /invite, /settings and /admin are never cached', () => {
  const cacheControl = (response: Response) => privateResponse(response).headers.get('cache-control');

  test('pages, form answers and redirects, even one whose headers are frozen', () => {
    expect(cacheControl(new Response('<html>', { headers: { 'content-type': 'text/html', 'cache-control': 'max-age=60' } }))).toBe(
      'private, no-store',
    );
    expect(cacheControl(new Response(null, { status: 303, headers: { location: '/' } }))).toBe('private, no-store');
    expect(cacheControl(Response.redirect('https://feddit.test/auth/sign-in', 307))).toBe('private, no-store');
  });

  test.each([
    ['/auth', authGroup],
    ['/invite', inviteGroup],
    ['/settings', settingsGroup],
    ['/admin', adminGroup],
  ])('%s runs the rule for every route below it', (_, group) => {
    expect(group.options.server?.middleware).toContain(privateResponses);
  });
});

describe('form handlers pass on the session cookie better-auth refreshed', () => {
  const session: CurrentSession = {
    view: {
      userId: '01a1bb85-1d50-7c45-8365-90817bf1be16',
      actorId: '01a1bb85-1d50-7c45-8365-90817bf1be17',
      name: 'mira',
      displayName: null,
      siteRole: 'user',
      emailVerified: true,
      twoFactorEnabled: false,
      ageDeclaredAt: null,
    },
    sessionId: '01a1bb85-1d50-7c45-8365-90817bf1be18',
    email: 'mira@example.test',
    role: 'user',
    sessionCreatedAt: new Date(),
    setCookies: ['peblish.session_token=refreshed; Path=/; HttpOnly'],
  };
  const post = (accept?: string) =>
    new Request('https://feddit.test/settings/security', { method: 'POST', headers: accept ? { accept } : {} });

  test("on a redirect, an error and a JSON answer, before the answer's own cookies", () => {
    const { reply } = withSession(post(), session);
    expect(reply({ redirect: '/settings/security' }).headers.getSetCookie()).toEqual(session.setCookies);
    expect(reply({ error: 'password.wrong', back: '/settings/security' }).headers.getSetCookie()).toEqual(session.setCookies);
    const signedOut = 'peblish.session_token=; Path=/; Max-Age=0';
    expect(
      withSession(post('application/json'), session)
        .reply({ redirect: '/', cookies: [signedOut] })
        .headers.getSetCookie(),
    ).toEqual([...session.setCookies, signedOut]);
  });

  test('signed out, nothing to pass on', () => {
    expect(withSession(post(), null).reply({ redirect: '/auth/sign-in' }).headers.getSetCookie()).toEqual([]);
  });
});

describe('sameOrigin refuses cross-site form posts', () => {
  const post = (headers: Record<string, string>, url = 'https://feddit.test/auth/sign-in') => new Request(url, { method: 'POST', headers });
  test.each([
    ['a matching Origin', post({ origin: 'https://feddit.test' }), true],
    ['a foreign Origin', post({ origin: 'https://attacker.example' }), false],
    ['a lookalike Origin', post({ origin: 'https://feddit.test.attacker.example' }), false],
    ['an opaque Origin, cross-site', post({ origin: 'null', 'sec-fetch-site': 'cross-site' }), false],
    ['an opaque Origin, same-origin', post({ origin: 'null', 'sec-fetch-site': 'same-origin' }), true],
    ['an opaque Origin, no fetch metadata', post({ origin: 'null' }), false],
    ['no Origin, a sibling site', post({ 'sec-fetch-site': 'same-site' }), false],
    ['no headers (not a browser)', post({}), true],
    // A TLS proxy hands over plain http on an internal address, with the public Host.
    ['behind a TLS proxy', post({ host: 'feddit.test', origin: 'https://feddit.test' }, 'http://web:3000/auth/sign-in'), true],
    [
      'behind a TLS proxy, a foreign Origin',
      post({ host: 'feddit.test', origin: 'https://attacker.example' }, 'http://web:3000/auth/sign-in'),
      false,
    ],
  ])('%s', (_, request, allowed) => expect(sameOrigin(request)).toBe(allowed));
});

describe('the client address comes from a header only when its proxy is trusted', () => {
  const headers = new Headers({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7', 'cf-connecting-ip': '192.0.2.9' });
  test('no proxy: the peer, whatever the headers claim', () => expect(clientAddress(headers, 'none', '10.0.0.5')).toBe('10.0.0.5'));
  test('Traefik: the address it appended last, not one the client sent', () =>
    expect(clientAddress(headers, 'traefik', '10.0.0.2')).toBe('203.0.113.7'));
  test('Cloudflare: CF-Connecting-IP', () => expect(clientAddress(headers, 'cloudflare', '10.0.0.2')).toBe('192.0.2.9'));
  test('a missing header falls back to the peer', () => expect(clientAddress(new Headers(), 'traefik', '10.0.0.2')).toBe('10.0.0.2'));
});
