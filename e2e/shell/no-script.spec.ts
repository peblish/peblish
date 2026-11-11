import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { freshTotp } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The shell with scripts off (`@media (scripting: none)`, shell.css): the account menu and the
// phone drawer cannot open, so the account's pages and sign-out are plain links and a form under
// the page, and on a phone the Sidebar's navigation is laid out under the page.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

const root = join(import.meta.dirname, '../..');
const desktop = { width: 1280, height: 800 };
const phone = { width: 390, height: 800 };

/** A fresh admin with two-factor on, this test's own. */
function seedAdmin() {
  const { password, admin } = JSON.parse(execFileSync('node', ['e2e/shell/seed.ts', 'admin'], { cwd: root, encoding: 'utf8' })) as {
    password: string;
    admin: { name: string; totpSecret: string };
  };
  return { ...admin, password };
}

/** Signs in through the plain forms, as a browser without scripts does. */
async function signInWithoutScripts(page: Page, admin: ReturnType<typeof seedAdmin>) {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email or handle').fill(`@${admin.name}`);
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/auth\/two-factor/);
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(admin.totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((url) => url.pathname === '/');
}

async function withoutScripts(browser: Browser, baseURL: string | undefined, viewport: typeof desktop, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport, baseURL });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

for (const [layout, viewport] of [
  ['desktop', desktop],
  ['phone', phone],
] as const) {
  test(`${layout}, scripts off: an admin reaches Profile, Settings and Admin from the Account link, and signs out`, async ({
    browser,
    baseURL,
  }) => {
    const admin = seedAdmin();
    await withoutScripts(browser, baseURL, viewport, async (page) => {
      await signInWithoutScripts(page, admin);
      const banner = page.getByRole('banner');
      // The menu's button cannot open without scripts: it gives way to a link with the same name.
      await expect(banner.getByRole('button', { name: `Account: ${admin.name}` })).toHaveCount(0);
      const account = banner.getByRole('link', { name: `Account: ${admin.name}` });
      await expect(account).toBeVisible();
      await expect(banner.getByRole('button', { name: 'Appearance' })).toHaveCount(0);

      const destinations = [
        ['Profile', `/u/${admin.name}`],
        ['Settings', '/settings/account'],
        ['Security', '/settings/security'],
        ['Invites', '/admin/registration'],
        ['Admin', '/admin/settings'],
      ] as const;
      for (const [name, path] of destinations) {
        await page.goto('/');
        await account.click();
        await page.waitForURL((url) => url.hash === '#pb-account-links');
        const list = page.getByRole('navigation', { name: 'Account' });
        await expect(list).toBeInViewport();
        await list.getByRole('link', { name, exact: true }).click();
        await page.waitForURL((url) => url.pathname === path);
        await expect(page.getByRole('main')).toBeVisible();
      }

      await account.click();
      await page.getByRole('navigation', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
      await page.waitForURL((url) => url.pathname === '/');
      await expect(banner.getByRole('link', { name: 'Sign in' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Profile' })).toHaveCount(0);
    });
  });
}

test('phone, scripts off: the navigation sits under the page, and Terms and a community are a tap away', async ({ browser, baseURL }) => {
  // At least one local community for the signed-out sidebar to list (the payload budget's seed).
  execFileSync('node', ['packages/core/src/testing/seed-b1.ts', 'e2e'], { cwd: root, encoding: 'utf8' });
  await withoutScripts(browser, baseURL, phone, async (page) => {
    await page.goto('/');
    // The drawer's button needs scripts: it is gone, and the Sidebar column itself is laid out below the page.
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
    const side = page.getByRole('complementary', { name: 'Sidebar' });
    await expect(side).toBeVisible();
    const [main, sideBox] = [await page.getByRole('main').boundingBox(), await side.boundingBox()];
    expect(sideBox!.y, 'the navigation comes after the page').toBeGreaterThanOrEqual(main!.y + main!.height);
    expect(sideBox!.width, 'the column takes the phone width').toBeLessThanOrEqual(phone.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no sideways scroll').toBeLessThanOrEqual(phone.width);
    // The community filter only works with scripts.
    await expect(side.getByRole('textbox')).toHaveCount(0);

    await side.getByRole('navigation', { name: 'About this site' }).getByRole('link', { name: 'Terms' }).click();
    await page.waitForURL('**/terms');

    await page.goto('/');
    const community = page
      .getByRole('complementary', { name: 'Sidebar' })
      .getByRole('navigation', { name: 'Communities' })
      .getByRole('link', { name: /^!/ })
      .first();
    const href = await community.getAttribute('href');
    expect(href).toMatch(/^\/c\//);
    await community.click();
    await page.waitForURL((url) => url.pathname === href);
    await expect(page.getByRole('main')).toBeVisible();
  });
});

test('with scripts on, the account list and the no-script link are not shown and the menu is', async ({ page }) => {
  const admin = seedAdmin();
  await gotoHydrated(page, '/auth/sign-in');
  await page.getByLabel('Email or handle').fill(`@${admin.name}`);
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/auth\/two-factor/);
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(admin.totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('button', { name: `Account: ${admin.name}` })).toBeVisible();
  await expect(banner.getByRole('link', { name: `Account: ${admin.name}` })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Account' })).toHaveCount(0);
  await expect(page.locator('#pb-account-links')).toBeHidden();
});
