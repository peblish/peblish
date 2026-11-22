import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectAccessible, expectAccessibleOnPhone } from '../auth/support.ts';
import { prefsCookie, skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The public Instances page (branch 5, lane f-facts): reached from the site pages, it lists the peers
// this server federates with by domain and software, and nothing else about them.

type Seed = { suffix: string; listed: string; unknown: string; hidden: string[] };

test.describe('seeded', () => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
  let seed: Seed;
  test.beforeAll(() => {
    seed = JSON.parse(
      execFileSync('node', ['packages/core/src/testing/seed-facts.ts', 'instances'], {
        cwd: join(import.meta.dirname, '../..'),
        encoding: 'utf8',
      }),
    ) as Seed;
  });

  test('a permitted peer is listed with its software; blocked, paused and dormant ones, versions and times are not', async ({ page }) => {
    const response = await page.goto('/instances');
    expect(response?.status()).toBe(200);
    const list = page.getByRole('list', { name: /^Instances .* federates with$/ });
    await expect(list.getByRole('listitem').filter({ hasText: seed.listed })).toContainText('PieFed');
    await expect(list.getByRole('listitem').filter({ hasText: seed.unknown })).toContainText('Software unknown');
    // The whole document, the dehydrated loader data included.
    const html = await page.content();
    for (const hidden of [...seed.hidden, `9.9.9-${seed.suffix}`, '2026-02-03', `Blocked reason ${seed.suffix}`])
      expect(html).not.toContain(hidden);
  });
});

test('the page is reached from the site pages, scripts on and off, and is accessible in light and dark', async ({ page, browser }) => {
  await gotoHydrated(page, '/about');
  await page.getByRole('link', { name: 'Instances', exact: true }).first().click();
  await expect(page).toHaveURL(/\/instances$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Instances' })).toBeVisible();
  await expect(page).toHaveTitle(/^Instances/);
  await expectAccessible(page);
  await page.context().addCookies([{ ...prefsCookie('card', 'dark'), url: page.url() }]);
  await gotoHydrated(page, '/instances');
  await expectAccessible(page);

  const plain = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await plain.goto(new URL('/instances', page.url()).href);
  await expect(plain.getByRole('heading', { level: 1, name: 'Instances' })).toBeVisible();
  await expect(plain.getByText(/federates with/)).toBeVisible();
});

test('on a phone the page does not scroll sideways and is accessible', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await gotoHydrated(page, '/instances');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectAccessibleOnPhone(page);
  await context.close();
});

test.describe('the gallery', () => {
  test.beforeEach(async ({ request }) => skipWithoutKit(request));
  for (const path of ['/kit/instances-list', '/kit/instances-list-empty'])
    test(`${path} reads in light and dark, under forced colours, and fits a phone`, async ({ browser, baseURL }) => {
      for (const scheme of ['light', 'dark'] as const)
        for (const forcedColors of ['none', 'active'] as const) {
          const context = await browser.newContext({ baseURL, colorScheme: scheme, forcedColors });
          await context.addCookies([{ ...prefsCookie('card', scheme), url: baseURL! }]);
          const page = await context.newPage();
          await gotoHydrated(page, path);
          await expectAccessible(page);
          await context.close();
        }
      const phone = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true });
      const page = await phone.newPage();
      await gotoHydrated(page, path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await phone.close();
    });
});
