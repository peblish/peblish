import { expect, test } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';
import { siteName } from '../support/site-name.ts';

// The application frame (shell-sidebar): the sidebar, the top bar, the centred body and the
// drawer on a phone. Signed in, the account menu is covered by lane A's end-to-end flows and
// e2e/shell/account.spec.ts.
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
  await expect(page).toHaveTitle(await siteName(page));
});

test('every page has a title: the shell names the route, a route may name itself; the site is named, never the software', async ({
  page,
}) => {
  for (const [path, title] of [
    ['/', 'Home'],
    ['/auth/sign-in', 'Sign in'],
    ['/auth/sign-up', 'Create your account'],
  ] as const) {
    await gotoHydrated(page, path);
    const site = await siteName(page);
    await expect(page).toHaveTitle(`${title} · ${site}`);
  }
});

test('the brand is the site name, or the host when none is set, and never the software', async ({ page }) => {
  await gotoHydrated(page, '/');
  const site = await siteName(page);
  expect(site).not.toBe('');
  expect(site).not.toMatch(/^peblish$|on peblish/i);
});

test.describe('in German', () => {
  test.use({ locale: 'de-DE', extraHTTPHeaders: { 'Accept-Language': 'de-DE' } });

  test('the title is in the request locale', async ({ page }) => {
    await gotoHydrated(page, '/auth/sign-in');
    await expect(page).toHaveTitle(`Anmelden · ${await siteName(page)}`);
  });
});

test("on a phone the sidebar is Mux UI's drawer behind the menu button, with Appearance at its foot", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await gotoHydrated(page, '/');
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
  // Mux UI names the button and the drawer in English in every locale (rc.6).
  const open = page.getByRole('button', { name: 'Open navigation' });
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await open.click();
  await expect(drawer.getByRole('navigation', { name: 'Feeds' }).getByRole('link', { name: 'Local', exact: true })).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer.getByRole('button', { name: 'Appearance' })).toBeVisible();
  // Focus moved into the drawer; Escape closes it and gives focus back to the button.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(open).toBeFocused();

  // A link in the drawer navigates and closes it; Back does not bring it back.
  await open.click();
  await drawer.getByRole('link', { name: 'Find by handle' }).click();
  await page.waitForURL('**/resolve');
  await expect(drawer).toBeHidden();
  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(drawer).toBeHidden();
});

test('the skip link moves focus to the page content', async ({ page }) => {
  await gotoHydrated(page, '/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#pb-main')).toBeFocused();
});

test('the appearance popover closes on Escape and when a press lands outside it', async ({ page }) => {
  await gotoHydrated(page, '/');
  const trigger = page.getByRole('banner').getByRole('button', { name: 'Appearance' });
  const choices = page.getByRole('radiogroup', { name: 'Appearance' });
  await trigger.click();
  await expect(choices.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(choices).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(choices).toBeVisible();
  // The popover is modal: a press anywhere outside it lands on its underlay and closes it.
  await page.mouse.click(600, 500);
  await expect(choices).toBeHidden();
});
