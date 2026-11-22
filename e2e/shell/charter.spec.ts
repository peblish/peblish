import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectAccessible } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// A community's charter is in the page once, on every tab and at every width: beside a wide page in the rail,
// and where the rail gives way, on the About tab, the rail itself in the page's flow in place of the posts. So
// an id inside it (a footnote's, say) names one element, the one in view.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

let handle: string;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-b1.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  handle = (JSON.parse(out) as { community: { handle: string } }).community.handle;
});

for (const width of [1440, 1000, 390]) {
  test(`the About tab draws the charter once, in view, at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoHydrated(page, `/c/${handle}?tab=about`);
    // The charter ends with the way to the modlog: one, and shown.
    const modlog = page.getByRole('link', { name: /modlog/i });
    await expect(page.locator('.cm-modlog')).toHaveCount(1);
    await expect(modlog).toBeVisible();
    const charter = page.getByRole('complementary', { name: /^About / });
    await expect(charter).toBeVisible();
    await expect(charter.getByRole('region', { name: 'Rules' })).toBeVisible();
    if (width === 1440) {
      await expect(page.locator('.cm-posts')).toBeVisible();
    } else {
      // In place of the posts, under the tabs, and nothing sideways.
      await expect(page.locator('.cm-posts')).toBeHidden();
      const tabs = (await page.getByRole('navigation', { name: 'Posts and about' }).boundingBox())!;
      const box = (await charter.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
      expect(box.y - (tabs.y + tabs.height)).toBeLessThan(200);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    await expectAccessible(page);
  });
}

test('without scripts the About tab shows the charter once too', async ({ browser }) => {
  const page = await (await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1000, height: 900 } })).newPage();
  await page.goto(`/c/${handle}?tab=about`);
  await expect(page.locator('.cm-modlog')).toHaveCount(1);
  await expect(page.getByRole('complementary', { name: /^About / }).getByRole('region', { name: 'Rules' })).toBeVisible();
  await page.context().close();
});
