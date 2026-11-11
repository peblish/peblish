import { expect, test, type Page } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';

// The shell before its scripts run. Andrew's rule: readable without JavaScript, interactive with
// it. The Mux UI menus, the Appearance popover and the phone drawer need scripts; the page, the
// sidebar column and its links do not.

/** Holds every script request until the returned function is called, so the page stays server-rendered. */
async function holdScripts(page: Page): Promise<() => void> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname.endsWith('.js'),
    async (route) => {
      await gate;
      await route.continue().catch(() => undefined);
    },
  );
  return release;
}

const phone = { width: 390, height: 800 };

test('the bar and its controls are in the server HTML, and work once the page hydrates', async ({ page }) => {
  const release = await holdScripts(page);
  try {
    await page.goto('/', { waitUntil: 'commit' });
    const appearance = page.getByRole('banner').getByRole('button', { name: 'Appearance' });
    await expect(appearance).toBeVisible();
    expect(await page.locator('html').getAttribute('data-shell-hydrated')).toBeNull();

    release();
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await appearance.click();
    await expect(page.getByRole('radiogroup', { name: 'Appearance' })).toBeVisible();
  } finally {
    release();
  }
});

test('with scripts off, the page reads and the sidebar links are plain links', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  try {
    const page = await context.newPage();
    await page.goto('/');
    const side = page.getByRole('complementary', { name: 'Sidebar' });
    const feeds = side.getByRole('navigation', { name: 'Feeds' });
    for (const name of ['Local', 'All', 'Popular']) await expect(feeds.getByRole('link', { name })).toBeVisible();
    await expect(side.getByRole('navigation', { name: 'About this site' }).getByRole('link', { name: 'Privacy' })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/sign-in');
    await feeds.getByRole('link', { name: 'Local', exact: true }).click();
    await page.waitForURL('**/local');
    await expect(page.getByRole('main')).toBeVisible();
  } finally {
    await context.close();
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: phone });

  test('with scripts off, the phone bar and the page still render', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: phone, baseURL });
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
      // The drawer needs scripts; its button is there for when they run.
      await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
      await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/sign-in');
      await expect(page.getByRole('main')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('a drawer closes on a client-side navigation and stays closed on Back', async ({ page }) => {
    await gotoHydrated(page, '/');
    const open = page.getByRole('button', { name: 'Open navigation' });
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await open.click();
    await drawer.getByRole('link', { name: 'Local', exact: true }).click();
    await page.waitForURL('**/local');
    await expect(drawer).toBeHidden();
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await page.goBack();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(drawer).toBeHidden();
  });
});
