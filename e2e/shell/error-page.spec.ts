import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// The error page (shell/error-page.tsx): what a failed page shows on the server and in the
// browser, that it hydrates as itself, keeps a 5xx status, never shows the cause, and that Try
// again reruns the failed loader once.

/** A search value /post/<id> cannot take (its `error` must be a string): the route fails before its loader. */
const failingPage = '/post/00000000-0000-0000-0000-000000000000?error=%7B%22a%22%3A1%7D';

async function expectErrorPage(page: Page) {
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to the home page' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show Error' })).toHaveCount(0);
}

test('a page that fails on the server answers 500 with the error page in the shell, and hydrates without warnings', async ({ page }) => {
  // The server's own HTML is the error page (not the router's English fallback) and names no cause.
  const served = await page.request.get(failingPage);
  expect(served.status()).toBe(500);
  const html = await served.text();
  expect(html).toContain('>Something went wrong</h1>');
  expect(html).not.toContain('Show Error');
  expect(html).not.toContain('must be a string');

  const console = recordConsole(page);
  const response = await page.goto(failingPage, { waitUntil: 'commit' });
  expect(response?.status()).toBe(500);
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await expectErrorPage(page);
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
  // Neither the page nor the data it hydrates from names the cause.
  expect(await page.content()).not.toContain('must be a string');
  expect(console.hydrationProblems()).toEqual([]);
});

test('an unknown address still answers 404', async ({ page }) => {
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('Try again reruns the failed loader once, and shows the page when it loads', async ({ page }) => {
  await gotoHydrated(page, '/');
  // The resolver page's loader is a server function; fail every call until released.
  let calls = 0;
  let failing = true;
  await page.route('**/_serverFn/**', async (route) => {
    calls += 1;
    if (failing) await route.fulfill({ status: 500, contentType: 'text/plain', body: 'down' });
    else await route.continue();
  });
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: 'Find by handle' }).click();
  await page.waitForURL('**/resolve');
  await expectErrorPage(page);

  // Still failing: one press, one more call, the error page again, and nothing after it.
  const before = calls;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => calls).toBe(before + 1);
  await expectErrorPage(page);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
  await page.waitForTimeout(500);
  expect(calls).toBe(before + 1);

  failing = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Something went wrong');
  await expect(page.getByRole('main')).toBeVisible();
});

test.describe('when the root loader fails', () => {
  // Starts its own server from the local build, with a database that refuses connections.
  test.skip(Boolean(process.env.BASE_URL), 'starts its own server from packages/web/.output');

  async function freePort(): Promise<number> {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    server.close();
    await once(server, 'close');
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');
    return address.port;
  }

  test('every page answers 500 with the error page, in English, without the cause', async ({ browser }) => {
    const [port, database] = await Promise.all([freePort(), freePort()]);
    const { CI: _ci, TEST: _test, ...env } = process.env;
    const child = spawn(process.execPath, [join(import.meta.dirname, '../../packages/web/.output/server/index.mjs')], {
      env: { ...env, HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: `postgres://peblish:peblish@127.0.0.1:${database}/peblish` },
      stdio: 'ignore',
    });
    const origin = `http://127.0.0.1:${port}`;
    const context = await browser.newContext({ baseURL: origin, locale: 'de-DE', extraHTTPHeaders: { 'Accept-Language': 'de-DE' } });
    try {
      await expect
        .poll(
          () =>
            fetch(`${origin}/healthz`).then(
              (response) => response.status,
              () => 0,
            ),
          { timeout: 15_000 },
        )
        .toBe(200);
      const page = await context.newPage();
      const console = recordConsole(page);
      const response = await page.goto('/', { waitUntil: 'commit' });
      expect(response?.status()).toBe(500);
      await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
      await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
      await expectErrorPage(page);
      expect(await page.content()).not.toMatch(/ECONNREFUSED|127\.0\.0\.1:\d+|postgres:/);
      expect(console.messages.filter(({ type }) => type === 'pageerror')).toEqual([]);
      expect(console.hydrationProblems()).toEqual([]);
    } finally {
      await context.close();
      child.kill('SIGTERM');
    }
  });
});
