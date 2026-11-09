import { expect, test, type Page } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';

// The shell before its scripts run: a menu or drawer opened in that window must survive
// hydration, and on a phone the sidebar must be reachable with scripts off altogether.

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

test('a menu opened before hydration is still open after it', async ({ page }) => {
  const release = await holdScripts(page);
  try {
    await page.goto('/', { waitUntil: 'commit' });
    const menu = page.locator('details.pb-theme');
    await menu.locator('summary').click();
    await expect(menu).toHaveJSProperty('open', true);
    expect(await page.locator('html').getAttribute('data-shell-hydrated')).toBeNull();

    release();
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await expect(menu).toHaveJSProperty('open', true);

    // The dismissal is in place once hydrated.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveJSProperty('open', false);
  } finally {
    release();
  }
});

test('a menu left open is closed by a client-side navigation', async ({ page }) => {
  await gotoHydrated(page, '/');
  const menu = page.locator('details.pb-theme');
  await menu.locator('summary').click();
  await expect(menu).toHaveJSProperty('open', true);
  await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).click();
  await page.waitForURL('**/auth/sign-in');
  await expect(page.locator('details.pb-theme')).toHaveJSProperty('open', false);
});
