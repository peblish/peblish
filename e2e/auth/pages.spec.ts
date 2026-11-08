import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// The signed-out pages render in the request's locale, hydrate without a mismatch (dates and
// month names come from Intl in UTC on both sides) and have no axe violations.
const pages = [
  '/auth/sign-in',
  '/auth/sign-up?invite=PB-2222-2222',
  '/auth/two-factor',
  '/auth/reset',
  '/auth/reset?token=x',
  '/invite/PB-2222-2222',
];

for (const locale of ['en-US', 'de-DE'] as const) {
  test.describe(locale, () => {
    test.use({ locale, extraHTTPHeaders: { 'Accept-Language': locale } });

    test('lane A pages hydrate cleanly and pass axe', async ({ page }) => {
      const log = recordConsole(page);
      for (const path of pages) {
        await gotoHydrated(page, path);
        await expect(page.locator('html'), path).toHaveAttribute('lang', locale);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
          .analyze();
        expect(results.violations.map(({ id, nodes }) => ({ path, id, targets: nodes.map(({ target }) => target.join(' ')) }))).toEqual([]);
      }
      await page.waitForLoadState('networkidle');
      expect(log.hydrationProblems()).toEqual([]);
      expect(log.problems()).toEqual([]);
    });
  });
}

test('pages under /auth, /invite, /settings and /admin are never cached, redirects included', async ({ request }) => {
  const paths = ['/auth/sign-in', '/auth/two-factor', '/auth/reset', '/auth/reset?token=x', '/auth/sign-up', '/invite/PB-2222-2222'];
  // Signed out, the personal pages redirect to sign-in; the redirect is private too.
  const redirects = ['/auth/verify', '/settings/account', '/settings/security', '/admin/registration'];
  for (const path of [...paths, ...redirects]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect([path, response.status()]).toEqual([path, redirects.includes(path) ? 307 : 200]);
    expect([path, response.headers()['cache-control']]).toEqual([path, 'private, no-store']);
  }
  // A group's own path has no page.
  for (const path of ['/auth', '/invite', '/settings', '/admin']) expect([path, (await request.get(path)).status()]).toEqual([path, 404]);
});

test('a sign-in posted from another site is refused', async ({ request }) => {
  const response = await request.post('/auth/sign-in', {
    headers: { origin: 'https://attacker.example' },
    form: { identifier: 'nobody@example.test', password: 'not the password' },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
});
