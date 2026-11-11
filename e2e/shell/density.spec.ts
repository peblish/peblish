import { expect, test } from '@playwright/test';
import { prefsCookie, skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// PostCard in three densities, the always-visible density control, and the display cookie:
// the chosen density and scheme survive a reload and are in the server's HTML, so nothing flashes.
test.beforeEach(({ request }) => skipWithoutKit(request));

test('the same post lays out differently in Card, Classic and Compact', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const box = async (density: string, selector: string) =>
    page.locator(`[data-testid="kit-density-${density}"] article`).nth(1).locator(selector).boundingBox();

  // A text post: the excerpt is shown in Card and Classic and left out of Compact.
  const excerpt = (density: string) => page.locator(`[data-testid="kit-density-${density}"] article`).nth(1).locator('.pb-post__excerpt');
  await expect(excerpt('card')).toBeVisible();
  await expect(excerpt('classic')).toBeVisible();
  await expect(excerpt('compact')).toBeHidden();

  // A link post: Card puts a wide picture under the text, Classic a small one beside it, Compact none.
  const link = (density: string) => page.locator(`[data-testid="kit-density-${density}"] article`).first();
  const cardThumb = await link('card').locator('.pb-post__thumb').boundingBox();
  const cardBody = await link('card').locator('.pb-post__body').boundingBox();
  expect(cardThumb!.width).toBeGreaterThan(400);
  expect(cardThumb!.y).toBeGreaterThan(cardBody!.y + cardBody!.height - 1);
  const classicThumb = await link('classic').locator('.pb-post__thumb').boundingBox();
  const classicBody = await link('classic').locator('.pb-post__body').boundingBox();
  expect(classicThumb!.width).toBeLessThan(100);
  expect(classicThumb!.x + classicThumb!.width).toBeLessThanOrEqual(classicBody!.x);
  await expect(link('compact').locator('.pb-post__thumb')).toBeHidden();
  expect((await link('compact').boundingBox())!.height).toBeLessThan((await link('classic').boundingBox())!.height);
  expect(await box('card', '.pb-post__title')).not.toBeNull();
});

test('a sensitive post is hidden until shown', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const post = page.getByTestId('kit-feed').locator('article[data-sensitive]');
  await expect(post).toHaveAttribute('data-hidden', 'true');
  await expect(post.locator('.pb-post__excerpt')).toHaveCount(0);
  await post.getByRole('button', { name: 'hidden, show' }).click();
  await expect(post).not.toHaveAttribute('data-hidden');
  await expect(post.locator('.pb-post__excerpt')).toBeVisible();
  await expect(post.getByRole('button', { name: 'hide' })).toHaveAttribute('aria-pressed', 'true');
});

test('the density control switches the feed and the choice survives a reload', async ({ page, context, request }) => {
  await gotoHydrated(page, '/kit');
  const feed = page.getByTestId('kit-feed').locator('article').first();
  const control = page.getByRole('group', { name: 'View' });
  await expect(control.getByRole('button', { name: 'Classic' })).toHaveAttribute('aria-pressed', 'true');
  await expect(feed).toHaveAttribute('data-density', 'classic');

  // The first tap after the marker works, and the cookie is stored before the page reloads.
  await control.getByRole('button', { name: 'Compact' }).click();
  await expect(feed).toHaveAttribute('data-density', 'compact');
  await expect
    .poll(async () => (await context.cookies()).find(({ name }) => name === 'peblish_prefs')?.value)
    .toBe('density=compact&scheme=system');

  await page.reload();
  await expect(page.getByTestId('kit-feed').locator('article').first()).toHaveAttribute('data-density', 'compact');
  await expect(page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Compact' })).toHaveAttribute('aria-pressed', 'true');

  // The server rendered it: the HTML itself carries the density, so there is no flash before hydration.
  const html = await (await request.get('/kit', { headers: { cookie: 'peblish_prefs=density=card&scheme=black' } })).text();
  expect(/data-testid="kit-feed"[^]*?<article[^>]*data-density="(\w+)"/.exec(html)?.[1]).toBe('card');
  expect(html).toMatch(/<html[^>]*data-scheme="black"/);
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

  await page.getByText('Appearance', { exact: true }).click();
  await page.getByRole('button', { name: 'True black' }).click();
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Compact' }).click();
  const stored = async () => (await context.cookies()).find(({ name }) => name === 'peblish_prefs')?.value;
  await expect.poll(stored, { timeout: 10_000 }).toBe('density=compact&scheme=black');
  // The last answer has landed: the cookie does not drift back.
  await page.waitForTimeout(1_500);
  expect(await stored()).toBe('density=compact&scheme=black');

  await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'black');
  await expect(page.getByTestId('kit-feed').locator('article').first()).toHaveAttribute('data-density', 'compact');
});

test('a page with scripts off still shows the stored density and scheme', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies([{ ...prefsCookie('compact', 'black'), url: baseURL! }]);
  const page = await context.newPage();
  await page.goto('/kit');
  await expect(page.getByTestId('kit-feed').locator('article').first()).toHaveAttribute('data-density', 'compact');
  // A stored true black (no longer offered) renders as Mux UI's own dark scheme.
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'dark');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(0, 0, 0)');
  await context.close();
});

test('the appearance menu changes the scheme: true black is Mux UI dark, and it is stored', async ({ page, context }) => {
  await gotoHydrated(page, '/kit');
  await page.getByText('Appearance', { exact: true }).click();
  await page.getByRole('button', { name: 'True black' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'black');
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'dark');
  // The app has no third scheme: the body takes Mux UI's dark surface, not #000.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(0, 0, 0)');
  await expect.poll(async () => (await context.cookies()).find(({ name }) => name === 'peblish_prefs')?.value).toContain('scheme=black');

  await page.getByRole('button', { name: 'Light' }).click();
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
