import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// The You page (/you, Commons' You tab): signed in only; the viewer, the account's pages, Appearance, the
// site's pages and Sign out, all with scripts off too except Appearance; 44px targets on a phone; and no
// link to it in the page outside the phone's bottom bar.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = { password: string; viewers: string[]; owner: { name: string }; mod: { name: string } };

let seed: Seed;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-e1.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
});

async function signedIn(page: Page, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await landed(page, '/');
}

const account = (page: Page) => page.getByRole('main').getByRole('navigation', { name: 'Account' });

test('a visitor is sent to sign in and back', async ({ page }) => {
  await page.goto('/you');
  await expect(page).toHaveURL(/\/auth\/sign-in\?redirect=%2Fyou$/);
});

test("a member's You page: the account's pages, Appearance, the site's pages and Sign out", async ({ page }) => {
  const log = recordConsole(page);
  await signedIn(page, seed.viewers[0]!);
  await gotoHydrated(page, '/you');
  await expect(page).toHaveTitle(/^You · /);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(main).toContainText(`@${seed.viewers[0]}`);
  // A top destination: the page's own bar has no Back.
  await expect(page.getByRole('navigation', { name: 'Page' }).getByRole('button', { name: 'Back' })).toHaveCount(0);

  await expect(account(page).getByRole('link')).toHaveText(['Profile', 'Settings', 'Security']);
  await expect(account(page).getByRole('link', { name: 'Profile' })).toHaveAttribute('href', `/u/${seed.viewers[0]}`);
  // The page's own bar, the account's pages, then the site's pages (named by the site).
  const site = main.getByRole('navigation').last();
  await expect(site.getByRole('link')).toHaveText(['About', 'Code of conduct', 'Privacy', 'Terms']);
  await expectAccessible(page);
  expect(log.hydrationProblems()).toEqual([]);

  // Appearance (a single choice, so a radio group) applies at once and is kept.
  const appearance = main.getByRole('radiogroup', { name: 'Appearance' });
  await appearance.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'dark');
  await expectAccessible(page);
  await gotoHydrated(page, '/you');
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'dark');
  await expect(main.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Dark' })).toBeChecked();
  await main.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'System' }).click();

  await main.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/you$/);

  await main.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
  await page.goto('/you');
  await expect(page).toHaveURL(/\/auth\/sign-in/);
});

test('a moderator also has the moderation queue, after Profile', async ({ page }) => {
  await signedIn(page, seed.mod.name);
  await gotoHydrated(page, '/you');
  await expect(account(page).getByRole('link')).toHaveText(['Profile', 'Moderation queue', 'Settings', 'Security']);
  await expect(account(page).getByRole('link', { name: 'Moderation queue' })).toHaveAttribute('href', '/admin/reports');
});

test('without scripts the links and Sign out work, and Appearance is not offered', async ({ page, browser }) => {
  await signedIn(page, seed.viewers[1]!);
  const context = await browser.newContext({ storageState: await page.context().storageState(), javaScriptEnabled: false });
  const plain = await context.newPage();
  await plain.goto('/you');
  const main = plain.getByRole('main');
  await expect(main.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Security' })).toBeVisible();
  // The page's list and the frame's own account list (under the page with scripts off) are named apart.
  await expect(plain.getByRole('navigation', { name: 'Account', exact: true })).toHaveCount(1);
  await expect(plain.getByRole('navigation', { name: 'Account pages', exact: true })).toHaveCount(1);
  await expect(main.getByText('Appearance')).toBeHidden();
  await main.getByRole('button', { name: 'Sign out' }).click();
  await plain.goto('/you');
  await expect(plain).toHaveURL(/\/auth\/sign-in/);
  await context.close();
});

test('on a phone every link and button of the page is a 44px target; German has no axe violations', async ({ page, browser }) => {
  await signedIn(page, seed.viewers[2]!);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoHydrated(page, '/you');
    const sides = await page
      .getByRole('main')
      .locator('a, button')
      .evaluateAll((nodes) =>
        nodes.map((node) => Math.round(Math.min(node.getBoundingClientRect().width, node.getBoundingClientRect().height))),
      );
    expect(sides.length).toBeGreaterThan(8);
    expect(sides.filter((side) => side < 44)).toEqual([]);
    await expectAccessible(page);
  }
  const german = await (await browser.newContext({ storageState: await page.context().storageState(), locale: 'de-DE' })).newPage();
  await gotoHydrated(german, '/you');
  await expect(german.getByRole('main').getByRole('navigation', { name: 'Konto' })).toBeVisible();
  await expectAccessible(german);
  await german.context().close();
});

test('nothing in the page links to it but the phone bar', async ({ page }) => {
  await signedIn(page, seed.viewers[3]!);
  for (const path of ['/', `/u/${seed.viewers[3]}`, '/you']) {
    await gotoHydrated(page, path);
    const elsewhere = await page
      .locator('a[href="/you"]')
      .evaluateAll((links) => links.filter((link) => !link.closest('.pb-app__tabs')).length);
    expect(elsewhere, path).toBe(0);
  }
});
