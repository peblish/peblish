import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// PostRow (PostCard) in three densities, the always-visible density control, and the display cookie:
// the chosen density and scheme survive a reload and are in the server's HTML, so nothing flashes.
test.beforeEach(({ request }) => skipWithoutKit(request));

test('the same post lays out differently in Card, Classic and Compact', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const box = async (density: string, selector: string) =>
    page.locator(`[data-testid="kit-density-${density}"] article`).nth(1).locator(selector).boundingBox();

  // A text post: the excerpt is shown in Card only.
  const excerpt = (density: string) => page.locator(`[data-testid="kit-density-${density}"] article`).nth(1).locator('.pb-post__excerpt');
  await expect(excerpt('card')).toBeVisible();
  await expect(excerpt('classic')).toHaveCount(0);
  await expect(excerpt('compact')).toHaveCount(0);

  // A link post: Card puts a picture beside the title and the link line under it, Classic a smaller picture beside it, Compact none.
  const link = (density: string) => page.locator(`[data-testid="kit-density-${density}"] article`).first();
  const cardThumb = await link('card').locator('.pb-post__thumb').boundingBox();
  const cardTitle = await link('card').locator('.pb-post__title').boundingBox();
  await expect(link('card').locator('.pb-link-preview')).toBeVisible();
  expect(cardThumb!.x).toBeGreaterThanOrEqual(cardTitle!.x + cardTitle!.width);
  const classicThumb = await link('classic').locator('.pb-post__thumb').boundingBox();
  const classicTitle = await link('classic').locator('.pb-post__title').boundingBox();
  expect(classicThumb!.width).toBeLessThan(cardThumb!.width);
  expect(classicThumb!.x).toBeGreaterThanOrEqual(classicTitle!.x + classicTitle!.width);
  await expect(link('compact').locator('.pb-post__thumb')).toHaveCount(0);
  expect((await link('compact').boundingBox())!.height).toBeLessThan((await link('classic').boundingBox())!.height);
  expect(await box('card', '.pb-post__title')).not.toBeNull();
});

test('a sensitive post is covered until shown, and covered again by Hide', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'peblish_prefs', value: 'density=card&scheme=system', url: baseURL! }]);
  await gotoHydrated(page, '/kit');
  const post = page.getByTestId('kit-feed').locator('article[data-sensitive]');
  await expect(post).toHaveAttribute('data-hidden', 'true');
  // Covered, the picture is not in the page at all.
  await expect(post.locator('img')).toHaveCount(0);
  await post.getByRole('button', { name: 'Show' }).click();
  await expect(post).not.toHaveAttribute('data-hidden');
  await expect(post.locator('.pb-post__thumb img')).toBeVisible();
  // Focus moves to what was revealed, so the next Tab continues there.
  await expect(post.locator('.pb-cover-revealed')).toBeFocused();
  await post.getByRole('button', { name: 'Hide' }).click();
  await expect(post).toHaveAttribute('data-hidden', 'true');
  await expect(post.getByRole('button', { name: 'Show' })).toBeFocused();
});

test('the density control switches the feed and the choice survives a reload', async ({ page, context, request }) => {
  await gotoHydrated(page, '/kit');
  const feed = page.getByTestId('kit-feed').locator('article').first();
  const control = page.getByRole('radiogroup', { name: 'View' });
  await expect(control.getByRole('radio', { name: 'Classic' })).toHaveAttribute('aria-checked', 'true');
  await expect(feed).toHaveAttribute('data-density', 'classic');

  // The first tap after the marker works, and the cookie is stored before the page reloads.
  await control.getByRole('radio', { name: 'Compact' }).click();
  await expect(feed).toHaveAttribute('data-density', 'compact');
  await expect
    .poll(async () => (await context.cookies()).find(({ name }) => name === 'peblish_prefs')?.value)
    .toBe('density=compact&scheme=system');

  await page.reload();
  await expect(page.getByTestId('kit-feed').locator('article').first()).toHaveAttribute('data-density', 'compact');
  await expect(page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Compact' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // The server rendered it: the HTML itself carries the density, so there is no flash before hydration.
  // A stored true black (no longer offered) renders as Mux UI's dark scheme.
  const html = await (await request.get('/kit', { headers: { cookie: 'peblish_prefs=density=card&scheme=black' } })).text();
  expect(/data-testid="kit-feed"[^]*?<article[^>]*data-density="(\w+)"/.exec(html)?.[1]).toBe('card');
  expect(html).toMatch(/<html[^>]*data-scheme="dark"/);
  expect(html).toMatch(/<html[^>]*data-muxui-color-scheme="dark"/);
});

test('two quick changes both reach the cookie, on a slow connection', async ({ page, context }) => {
  // Scheme, then density, while the first save is still waiting for its answer. Saves that went
  // out together would each merge their one change into the same old cookie, and the later answer
  // would drop the other change; saves go out one at a time, each with both values.
  await gotoHydrated(page, '/kit');
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: -1, uploadThroughput: -1 });

  await page.getByRole('banner').getByRole('button', { name: 'Appearance' }).click();
  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Compact' }).click();
  const stored = async () => (await context.cookies()).find(({ name }) => name === 'peblish_prefs')?.value;
  await expect.poll(stored, { timeout: 10_000 }).toBe('density=compact&scheme=dark');
  // The last answer has landed: the cookie does not drift back.
  await page.waitForTimeout(1_500);
  expect(await stored()).toBe('density=compact&scheme=dark');

  await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'dark');
  await expect(page.getByTestId('kit-feed').locator('article').first()).toHaveAttribute('data-density', 'compact');
});

test('a page with scripts off still shows the stored density and scheme', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies([{ name: 'peblish_prefs', value: 'density=compact&scheme=black', url: baseURL! }]);
  const page = await context.newPage();
  await page.goto('/kit');
  await expect(page.getByTestId('kit-feed').locator('article').first()).toHaveAttribute('data-density', 'compact');
  // A stored true black (no longer offered) renders as Mux UI's own dark scheme.
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'dark');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(0, 0, 0)');
  await context.close();
});

test('the appearance popover changes the scheme, and it is stored', async ({ page, context }) => {
  await gotoHydrated(page, '/kit');
  await page.getByRole('banner').getByRole('button', { name: 'Appearance' }).click();
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'dark');
  // Mux UI's own dark surface, not #000.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(0, 0, 0)');
  await expect.poll(async () => (await context.cookies()).find(({ name }) => name === 'peblish_prefs')?.value).toContain('scheme=dark');
  await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'light');
});

test('"system" follows the operating system before the first paint', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ colorScheme: 'dark', baseURL });
  const page = await context.newPage();
  await page.goto('/kit');
  // The inline script switched the scheme while the page loaded, with no cookie yet.
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'dark');
  await page.locator('html[data-hydrated="1"]').waitFor();
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'dark');
  await context.close();
});
