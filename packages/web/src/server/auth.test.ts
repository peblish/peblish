import { describe, expect, test } from 'vitest';
import { Route as adminGroup } from '../routes/admin/route.tsx';
import { Route as authGroup } from '../routes/auth/route.tsx';
import { Route as inviteGroup } from '../routes/invite/route.tsx';
import { Route as settingsGroup } from '../routes/settings/route.tsx';
import { privateResponse, privateResponses, safeRedirect } from './auth.ts';

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
