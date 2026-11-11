import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The frame's geometry: what gives way in the phone bar at 320 and 360 px, and the sidebar
// column on a page longer than the screen.

/** The phone bar's parts, measured in the page. */
const bar = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const name = document.querySelector<HTMLElement>('.pb-bar-brand > .muxui-text')!;
    return {
      page: document.documentElement.scrollWidth,
      brand: box('.pb-bar-brand'),
      actions: box('.pb-app__bar .pb-app__actions'),
      menu: box('.muxui-sidebar__mobile-trigger'),
      nameCut: name.scrollWidth > name.clientWidth,
      ellipsis: getComputedStyle(name).textOverflow,
    };
  });

/** Whether an element shows only its icon: its label is visually hidden (1 px) and its icon drawn. */
const iconOnly = (page: Page, name: string) =>
  page
    .locator('.pb-app__bar')
    .getByRole('link', { name, exact: true })
    .evaluate(
      (link) =>
        link.querySelector('.pb-action__label')!.getBoundingClientRect().width <= 1 &&
        link.querySelector('svg')!.getBoundingClientRect().width > 0,
    );

async function signedInPage(browser: Browser): Promise<Page> {
  const { password, people } = JSON.parse(
    execFileSync('node', ['e2e/shell/seed.ts'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as { password: string; people: [string, string] };
  const page = await (await browser.newContext({ viewport: { width: 360, height: 700 } })).newPage();
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${people[0]}`, password);
  await landed(page, '/');
  return page;
}

for (const signedIn of [false, true]) {
  test(`phone bar at 320 and 360 px, signed ${signedIn ? 'in' : 'out'}: the actions give way before the site name`, async ({
    page,
    browser,
  }) => {
    test.skip(signedIn && Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
    const viewer = signedIn ? await signedInPage(browser) : page;
    for (const width of [320, 360]) {
      await viewer.setViewportSize({ width, height: 700 });
      for (const path of ['/', '/auth/sign-in', '/communities']) {
        await gotoHydrated(viewer, path);
        const at = `${width} px ${path}`;
        const { page: pageWidth, brand, actions, menu, nameCut } = await bar(viewer);
        expect(pageWidth, at).toBe(width);
        // The name, the actions and the menu button in that order, none overlapping, inside the bar.
        expect(brand.right, at).toBeLessThanOrEqual(actions.left);
        expect(actions.right, at).toBeLessThanOrEqual(menu.left);
        expect(menu.right, at).toBeLessThanOrEqual(width);
        // This instance's name ("b1.peblish.test" or the like) fits whole once the actions are icons.
        expect(nameCut, at).toBe(false);
        const banner = viewer.getByRole('banner');
        if (signedIn) {
          expect(await iconOnly(viewer, 'Create post'), at).toBe(true);
          await expect(banner.getByRole('button', { name: /^Account:/ })).toBeVisible();
        } else {
          // Below 360 px the signed-out labels give way too; their names stay.
          for (const name of ['Sign in', 'Sign up']) expect(await iconOnly(viewer, name), `${at} ${name}`).toBe(width < 360);
        }
      }
    }

    // A name too long for what is left ends in an ellipsis; the actions keep their size and the link its whole name.
    await viewer.setViewportSize({ width: 320, height: 700 });
    await gotoHydrated(viewer, '/');
    const before = await bar(viewer);
    const long = 'A community site with a very long name indeed';
    await viewer.locator('.pb-bar-brand > .muxui-text').evaluate((name, text) => (name.textContent = text), long);
    const after = await bar(viewer);
    expect(after.nameCut).toBe(true);
    expect(after.ellipsis).toBe('ellipsis');
    expect(after.actions.width).toBe(before.actions.width);
    expect(after.brand.right).toBeLessThanOrEqual(after.actions.left);
    expect(after.page).toBe(320);
    await expect(viewer.getByRole('banner').getByRole('link', { name: long })).toBeVisible();
  });
}

test('on a long page the sidebar stays in view, and its column runs the page height with the sidebar surface', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoHydrated(page, '/all');
  // However many posts the lane database holds, the page is several screens long.
  await page.locator('#pb-main main').evaluate((main) => {
    const spacer = document.createElement('div');
    spacer.style.blockSize = '3000px';
    main.append(spacer);
  });
  const side = page.getByRole('complementary', { name: 'Sidebar' });
  const column = page.locator('.pb-app__side');
  const height = await page.evaluate(() => Math.round(document.documentElement.getBoundingClientRect().height));
  expect(height).toBeGreaterThan(3 * 800);

  await page.screenshot({ path: test.info().outputPath('long-page.png'), fullPage: true });

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2 * 800);
  // The Sidebar is pinned to the screen, full height (to the pixel: a fractional page height leaves a fraction)...
  const sideBox = await side.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return [x, y, width, height].map((value) => Math.round(value) || 0);
  });
  expect(sideBox).toEqual([0, 0, 256, 800]);
  // ...and its column, which a full-page capture shows below the fold, spans the whole page in the same colour.
  const columnBox = await column.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { top: Math.round(box.top + window.scrollY), height: Math.round(box.height) };
  });
  expect(columnBox).toEqual({ top: 0, height });
  const background = (selector: string) => page.locator(selector).evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await background('.pb-app__side')).toBe(await background('.pb-side'));
});
