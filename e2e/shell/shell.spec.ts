import { expect, test } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';

// The application frame (shell-sidebar): the sidebar, the top bar, the centred body and the
// drawer on a phone. Signed in, the account menu is covered by lane A's end-to-end flows.
test('the sidebar holds the feeds, the directory links and the site pages, and the body is centred in what is left', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, '/');
  const side = page.getByRole('complementary', { name: 'Sidebar' });
  const feeds = side.getByRole('navigation', { name: 'Feeds' });
  for (const name of ['Local', 'All', 'Popular']) await expect(feeds.getByRole('link', { name })).toBeVisible();
  // Subscribed and Moderating need a signed-in viewer.
  await expect(feeds.getByRole('link', { name: 'Subscribed' })).toHaveCount(0);
  const communities = side.getByRole('navigation', { name: 'Communities' });
  await expect(communities.getByRole('link', { name: 'Browse all communities' })).toHaveAttribute('href', '/communities');
  await expect(communities.getByRole('link', { name: 'Find by handle' })).toHaveAttribute('href', '/resolve');
  const about = side.getByRole('navigation', { name: 'About this site' });
  for (const name of ['Rules', 'Terms', 'Privacy', 'About']) await expect(about.getByRole('link', { name })).toBeVisible();

  // Signed out: sign-in and sign-up in the top bar, no create-post entry.
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/sign-in');
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/auth/sign-up');
  await expect(page.getByRole('link', { name: 'Create post' })).toHaveCount(0);

  // The sign-in form is narrower than the column, and sits in the middle of the width the sidebar leaves.
  await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).click();
  await page.waitForURL('**/auth/sign-in');
  await page.locator('html[data-hydrated="1"]').waitFor();
  const sideBox = (await side.boundingBox())!;
  const main = (await page.getByRole('main').boundingBox())!;
  const rest = { left: sideBox.x + sideBox.width, right: 1440 };
  const spaceLeft = main.x - rest.left;
  const spaceRight = rest.right - (main.x + main.width);
  expect(Math.abs(spaceLeft - spaceRight)).toBeLessThan(2);
  expect(spaceLeft).toBeGreaterThan(100);
});

test('an unknown address answers with the shell and a page not found message', async ({ page }) => {
  await gotoHydrated(page, '/no-such-page');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page).toHaveTitle('peblish');
});

test('every page has a title: the shell names the route, a route may name itself', async ({ page }) => {
  for (const [path, title] of [
    ['/', 'Home · peblish'],
    ['/auth/sign-in', 'Sign in · peblish'],
    ['/auth/sign-up', 'Create your account · peblish'],
  ] as const) {
    await gotoHydrated(page, path);
    await expect(page).toHaveTitle(title);
  }
});

test.describe('in German', () => {
  test.use({ locale: 'de-DE', extraHTTPHeaders: { 'Accept-Language': 'de-DE' } });

  test('the title is in the request locale', async ({ page }) => {
    await gotoHydrated(page, '/auth/sign-in');
    await expect(page).toHaveTitle('Anmelden · peblish');
  });
});

test('on a phone the sidebar is a drawer behind the menu link', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await gotoHydrated(page, '/');
  const side = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(side).toBeHidden();
  const open = page.getByRole('link', { name: 'Open menu' });
  await open.click();
  await expect(side).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  // The page behind is inert while the drawer is open, and focus moved into the drawer.
  await expect(page.locator('.pb-app__body')).toHaveAttribute('inert', '');
  await expect(page.getByRole('link', { name: 'Close menu' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(side).toBeHidden();
  await expect(open).toBeFocused();
  // Once hydrated the drawer is state, not the URL: opening it leaves no hash or history entry behind.
  expect(page.url()).not.toContain('#');

  // A link in the drawer navigates and closes it.
  await open.click();
  await side.getByRole('link', { name: 'Find by handle' }).click();
  await page.waitForURL('**/resolve');
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
});

test('the skip link moves focus to the page content', async ({ page }) => {
  await gotoHydrated(page, '/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#pb-main')).toBeFocused();
});

test('the appearance menu closes on Escape and when a press lands outside it', async ({ page }) => {
  await gotoHydrated(page, '/');
  const menu = page.locator('details.pb-theme');
  await menu.locator('summary').click();
  await expect(menu).toHaveJSProperty('open', true);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveJSProperty('open', false);
  await menu.locator('summary').click();
  await page.getByRole('main').click({ position: { x: 5, y: 5 } });
  await expect(menu).toHaveJSProperty('open', false);
});
