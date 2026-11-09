import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { skipWithoutKit, prefsCookie } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// axe on the shell (the home page) and on the component gallery, after hydration, in the three
// colour schemes and both locales: WCAG 2.2 A and AA plus axe best practices.
const schemes = ['light', 'dark', 'black'] as const;

for (const locale of ['en-US', 'de-DE'] as const) {
  test.describe(locale, () => {
    test.use({ locale, extraHTTPHeaders: { 'Accept-Language': locale } });
    for (const path of ['/', '/kit']) {
      for (const scheme of schemes) {
        test(`${path} has no axe violations (${scheme}, ${locale})`, async ({ page, request, context, baseURL }) => {
          if (path === '/kit') await skipWithoutKit(request);
          await context.addCookies([{ ...prefsCookie('classic', scheme), url: baseURL! }]);
          await gotoHydrated(page, path);
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          // The page really is in the locale: the sidebar's Local feed link.
          await expect(page.getByRole('link', { name: locale === 'de-DE' ? 'Lokal' : 'Local', exact: true })).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme);
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
            .analyze();
          expect(results.passes.length).toBeGreaterThan(10);
          expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target.join(' ')) }))).toEqual([]);
        });
      }
    }
  });
}
