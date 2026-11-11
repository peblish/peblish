import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The phone bar (below 860 px): the brand and the actions beside Mux UI's drawer button, taps on
// a touch screen, where focus goes when a drawer link or Back changes the page, and the bar's
// height on a page shorter than the screen.
test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });

/** Lets the press that was just sent finish: every handler it starts runs within two frames. */
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const drawer = (page: Page) => page.getByRole('dialog', { name: 'Navigation' });
const opener = (page: Page) => page.getByRole('button', { name: 'Open navigation' });
const focusInPage = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('#pb-main'));

test('tapping the brand on the home page does not open the drawer', async ({ page }) => {
  await gotoHydrated(page, '/');
  await page.locator('.pb-bar-brand').tap();
  await settle(page);
  await expect(drawer(page)).toHaveCount(0);
  await expect(opener(page)).toHaveAttribute('aria-expanded', 'false');
});

test('tapping Account opens the account menu and only that', async ({ page }) => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
  const { password, people } = JSON.parse(
    execFileSync('node', ['e2e/shell/seed.ts'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as { password: string; people: [string, string] };
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${people[0]}`, password);
  await landed(page, '/');

  await page
    .getByRole('banner')
    .getByRole('button', { name: `Account: ${people[0]}` })
    .tap();
  await expect(page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Settings' })).toBeVisible();
  await settle(page);
  await expect(drawer(page)).toHaveCount(0);
  await expect(opener(page)).toHaveAttribute('aria-expanded', 'false');
});

test('the bar is one landmark holding the brand, the actions and the drawer button, and axe passes', async ({ page }) => {
  await gotoHydrated(page, '/');
  const banner = page.getByRole('banner');
  await expect(banner).toHaveCount(1);
  await expect(banner.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expectAccessible(page);
});

test('a drawer link moves focus into the new page, and so does Back with the drawer open', async ({ page }) => {
  await gotoHydrated(page, '/');
  await opener(page).click();
  await drawer(page).getByRole('link', { name: 'Find by handle' }).click();
  await page.waitForURL('**/resolve');
  await expect(drawer(page)).toBeHidden();
  await expect.poll(() => focusInPage(page)).toBe(true);
  await expect(page.locator('#pb-main main')).toBeFocused();

  await opener(page).click();
  await expect(drawer(page)).toBeVisible();
  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(drawer(page)).toBeHidden();
  await expect.poll(() => focusInPage(page)).toBe(true);
});

test('on a page shorter than the screen the bar keeps its height and the page starts under it', async ({ page }) => {
  await gotoHydrated(page, '/no-such-page');
  const bar = (await page.locator('.pb-app__bar').boundingBox())!;
  const header = (await page.locator('.pb-app__bar .muxui-sidebar__mobile-header').boundingBox())!;
  const body = (await page.locator('.pb-app__body').boundingBox())!;
  expect(Math.abs(bar.height - header.height)).toBeLessThan(1);
  expect(Math.abs(body.y - (bar.y + bar.height))).toBeLessThan(1);
  // The spare height belongs to the page.
  expect(Math.abs(body.y + body.height - 800)).toBeLessThan(1);
});
