import { expect, test, type Page } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';

// The frame's loading hosts (packages/web/src/shell/pending.tsx), as Commons has them: a page whose data comes
// late shows its skeleton in a busy <main> with one status that says what is loading, inside the frame, and the
// page takes its place when the data arrives. A page that draws its own view header draws it while it loads too,
// so the frame's default bar never stands in for it. Only a navigation in the browser can show one.
test.use({ viewport: { width: 1440, height: 900 } });

/** The router's data requests answer late, past its pending delay (a second), so the host shows. */
const slowData = (page: Page) =>
  page.route('**/_serverFn/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });

const busy = (page: Page) => page.locator('#pb-main main[aria-busy="true"]');
/** The frame's own bar, which a page with its own view header leaves out. */
const defaultBar = (page: Page) => page.locator('#pb-main > .pb-frame-vh');

test("a slow feed shows its own bar and its rows as shapes in a busy main, one status naming what loads, then the feed's own main", async ({
  page,
}) => {
  await gotoHydrated(page, '/about');
  await slowData(page);
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: 'All', exact: true }).click();
  await expect(busy(page)).toBeVisible();
  await expect(busy(page).getByRole('status')).toHaveText('Loading posts');
  await expect(busy(page).locator('.muxui-skeleton__line').first()).toBeVisible();
  // The feed's bar, with its name, and not the frame's default one.
  await expect(busy(page).locator('.pb-frame-vh').getByRole('heading', { level: 1, name: 'All' })).toBeVisible();
  await expect(defaultBar(page)).toHaveCount(0);
  // The shapes are inert and hidden from assistive technology: nothing to reach or read but the status.
  await expect(busy(page).locator('.pb-rows').locator('a, button, input')).toHaveCount(0);
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
  await expect(busy(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('#pb-main main.feed')).toBeVisible();
  await expect(defaultBar(page)).toHaveCount(0);
});

test("a slow post shows the post and the first of its thread as shapes, with the post's own status", async ({ page }) => {
  await gotoHydrated(page, '/all?sort=new');
  const title = page.locator('#pb-main .pb-post__title a').first();
  test.skip(!(await title.count()), 'needs a post in the lane database');
  await slowData(page);
  await title.click();
  await expect(busy(page).getByRole('status')).toHaveText('Loading the post and its comments');
  // The post page's own bar, Back with the community to come with the post, not the default bar with the feed's name.
  const bar = page.locator('#pb-main > .pb-frame-vh').filter({ visible: true });
  await expect(bar).toHaveCount(1);
  await expect(bar.getByRole('button', { name: 'Back' })).toBeVisible();
  await expect(bar.locator('.pb-vh__title')).toHaveText('');
  await expect(busy(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('#pb-main main.post-page')).toBeVisible();
  await expect(bar.getByRole('link', { name: /^Post in !/ })).toBeVisible();
});
