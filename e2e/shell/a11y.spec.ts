import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';

// axe on the shell after hydration, WCAG 2.2 A and AA plus axe best practices.
for (const locale of ['en-US', 'de-DE'] as const) {
  test(`the shell has no axe violations (${locale})`, async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'Accept-Language': locale });
    await gotoHydrated(page, '/');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(results.passes.length).toBeGreaterThan(10);
    expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target.join(' ')) }))).toEqual([]);
  });
}
