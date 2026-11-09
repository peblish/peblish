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

const phone = { width: 390, height: 800 };

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

test.describe('on a phone', () => {
  test.use({ viewport: phone });

  test('a drawer opened before hydration is still open after it, and then behaves as state', async ({ page }) => {
    const release = await holdScripts(page);
    try {
      await page.goto('/', { waitUntil: 'commit' });
      const side = page.getByRole('complementary', { name: 'Sidebar' });
      await expect(side).toBeHidden();
      await page.getByRole('link', { name: 'Open menu' }).click();
      await expect(side).toBeVisible();
      expect(page.url()).toContain('#pb-side');

      release();
      await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
      await expect(side).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'true');
      // Taken over: the hash is gone and the page behind is inert, like a drawer React opened.
      await expect(page.locator('.pb-app__body')).toHaveAttribute('inert', '');
      expect(page.url()).not.toContain('#');

      await page.keyboard.press('Escape');
      await expect(side).toBeHidden();
    } finally {
      release();
    }
  });

  test('an adopted drawer replaces its history entry once, closes on a link tap and stays closed on Back', async ({ page }) => {
    const release = await holdScripts(page);
    try {
      await page.goto('/', { waitUntil: 'commit' });
      const side = page.getByRole('complementary', { name: 'Sidebar' });
      await page.getByRole('link', { name: 'Open menu' }).click();
      await expect(side).toBeVisible();
      const entries = await page.evaluate(() => history.length);

      release();
      await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
      await expect(side).toBeVisible();
      await expect(page.locator('.pb-app__body')).toHaveAttribute('inert', '');
      // The hash entry the link made was replaced, not joined by another.
      expect(await page.evaluate(() => history.length)).toBe(entries);
      expect(page.url()).not.toContain('#');

      // A tap on a sidebar link after hydration: the page changes and the drawer is closed, with
      // nothing left over from the :target that opened it (a stale :target must not reopen it).
      await side.getByRole('link', { name: 'Local', exact: true }).click();
      await page.waitForURL('**/local');
      await expect(side).toBeHidden();
      await expect(page.locator('.pb-app__body')).not.toHaveAttribute('inert');
      expect(page.url()).not.toContain('#');

      // Back returns to the first page with the drawer still closed.
      await page.goBack();
      await page.waitForURL((url) => url.pathname === '/' && url.hash === '');
      await expect(side).toBeHidden();
      await expect(page.locator('.pb-app__body')).not.toHaveAttribute('inert');
      await expect(page.getByRole('link', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
    } finally {
      release();
    }
  });

  test('with scripts off, the menu link opens the sidebar and its links work', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: phone, baseURL });
    try {
      const page = await context.newPage();
      await page.goto('/');
      const side = page.getByRole('complementary', { name: 'Sidebar' });
      await expect(side).toBeHidden();

      await page.getByRole('link', { name: 'Open menu' }).click();
      await expect(side).toBeVisible();
      const feeds = side.getByRole('navigation', { name: 'Feeds' });
      for (const name of ['Local', 'All', 'Popular']) await expect(feeds.getByRole('link', { name })).toBeVisible();
      await expect(side.getByRole('navigation', { name: 'About this site' }).getByRole('link', { name: 'Privacy' })).toBeVisible();

      // The close link and the scrim end it again.
      await side.getByRole('link', { name: 'Close menu' }).click();
      await expect(side).toBeHidden();
      await page.getByRole('link', { name: 'Open menu' }).click();
      await expect(side).toBeVisible();
      await page.locator('.pb-scrim').click({ position: { x: 360, y: 400 } });
      await expect(side).toBeHidden();

      // A link in the sidebar is a plain link: it loads its page.
      await page.getByRole('link', { name: 'Open menu' }).click();
      await side.getByRole('link', { name: 'Local', exact: true }).click();
      await page.waitForURL('**/local');
    } finally {
      await context.close();
    }
  });
});
