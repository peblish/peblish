import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The frame's geometry: the phone's two bars at 320 and 360 px, the header and the sidebar on a page
// longer than the screen, and the sidebar's community rows with long or unusual names.

/** Mux Sidebar's open width, its 1px edge left out, from the custom property Mux declares for layouts beside it. */
const openSize = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.inlineSize = 'var(--muxui-component-sidebar-open-size)';
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  });

/** The phone's bars, measured in the page. */
const bars = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element) => element.getBoundingClientRect().toJSON() as DOMRect;
    const top = document.querySelector('.pb-frame-vh')!;
    const name = top.querySelector<HTMLElement>('.pb-bar-brand > .muxui-text');
    return {
      page: document.documentElement.scrollWidth,
      brand: box(top.querySelector('.pb-bar-brand')!),
      finder: box(top.querySelector('.pb-find')!),
      menu: box(top.querySelector('.muxui-sidebar__mobile-trigger')!),
      nameCut: name ? name.scrollWidth > name.clientWidth : false,
      ellipsis: name ? getComputedStyle(name).textOverflow : '',
      tabs: [...document.querySelectorAll('.pb-tabbar__tab')].map(box),
    };
  });

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
  test(`the phone's bars at 320 and 360 px, signed ${signedIn ? 'in' : 'out'}: everything fits, in order, at 44px or more`, async ({
    page,
    browser,
  }) => {
    test.skip(signedIn && Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
    const viewer = signedIn ? await signedInPage(browser) : page;
    for (const width of [320, 360]) {
      await viewer.setViewportSize({ width, height: 700 });
      // The inbox too: its bar once cut the instance's name short ("e2.peb...").
      for (const path of ['/', '/auth/sign-in', '/communities', ...(signedIn ? ['/notifications'] : [])]) {
        await gotoHydrated(viewer, path);
        const at = `${width} px ${path}`;
        const { page: pageWidth, brand, finder, menu, nameCut, tabs } = await bars(viewer);
        expect(pageWidth, at).toBe(width);
        // The mark or name, the finder and the menu button in that order, none overlapping, inside the bar.
        expect(brand.right, at).toBeLessThanOrEqual(finder.left);
        expect(finder.right, at).toBeLessThanOrEqual(menu.left);
        expect(menu.right, at).toBeLessThanOrEqual(width);
        for (const target of [brand, finder, menu]) expect(Math.min(target.width, target.height), at).toBeGreaterThanOrEqual(44);
        // This instance's name ("b1.peblish.test" or the like) fits whole.
        expect(nameCut, at).toBe(false);
        // Five tabs side by side across the width, each a 44px target.
        expect(tabs, at).toHaveLength(5);
        for (const [index, tab] of tabs.entries()) {
          expect(Math.min(tab.width, tab.height), `${at} tab ${index}`).toBeGreaterThanOrEqual(44);
          if (index > 0) expect(tab.left, `${at} tab ${index}`).toBeGreaterThanOrEqual(tabs[index - 1]!.right - 0.5);
        }
        expect(tabs.at(-1)!.right, at).toBeLessThanOrEqual(width + 0.5);
      }
    }

    // A name too long for what is left ends in an ellipsis; the finder and the menu keep their size and the link its whole name.
    await viewer.setViewportSize({ width: 320, height: 700 });
    await gotoHydrated(viewer, '/');
    const brandText = viewer.locator('.pb-frame-vh .pb-bar-brand > .muxui-text');
    test.skip((await brandText.count()) === 0, 'a brand pack shows its mark, not the name, on the phone');
    const before = await bars(viewer);
    const long = 'A community site with a very long name indeed';
    await brandText.evaluate((name, text) => (name.textContent = text), long);
    const after = await bars(viewer);
    expect(after.nameCut).toBe(true);
    expect(after.ellipsis).toBe('ellipsis');
    expect(after.finder.width).toBe(before.finder.width);
    expect(after.menu.width).toBe(before.menu.width);
    expect(after.brand.right).toBeLessThanOrEqual(after.finder.left);
    expect(after.page).toBe(320);
    await expect(viewer.getByRole('navigation', { name: 'Page', exact: true }).getByRole('link', { name: long })).toBeVisible();
  });
}

test('on a long page the header stays at the top and the sidebar under it, and the centre column runs the page height', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoHydrated(page, '/all');
  // However many posts the lane database holds, the page is several screens long.
  await page.locator('#pb-main main').evaluate((main) => {
    const spacer = document.createElement('div');
    spacer.style.blockSize = '3000px';
    main.append(spacer);
  });
  const height = await page.evaluate(() => Math.round(document.documentElement.getBoundingClientRect().height));
  expect(height).toBeGreaterThan(3 * 800);
  await page.screenshot({ path: test.info().outputPath('long-page.png'), fullPage: true });

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2 * 800);
  const rounded = (selector: string) =>
    page.locator(selector).evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].map((value) => Math.round(value) || 0);
    });
  // The header is pinned to the top, 4rem and its hairline; the Sidebar under it, Mux's open width (16rem)
  // and its hairline wide and the rest of the screen tall.
  expect(await rounded('.pb-top')).toEqual([0, 0, 1280, 65]);
  expect(await rounded('.pb-side')).toEqual([0, 65, Math.round((await openSize(page)) + 1), 735]);
  // The centre column's hairlines run from under the header to the page's end.
  const frame = await page.locator('#pb-main').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { top: Math.round(box.top + window.scrollY), bottom: Math.round(box.bottom + window.scrollY) };
  });
  expect(frame).toEqual({ top: 65, bottom: height });
  // One ground: the sidebar is on the page's own surface.
  const background = (selector: string) => page.locator(selector).evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await background('.pb-side')).toBe(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
});

test('a long community name in the sidebar ends in an ellipsis, keeps its whole name and never widens the column', async ({ page }) => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
  // At least one local community for the signed-out sidebar to list (the payload budget's seed).
  execFileSync('node', ['packages/core/src/testing/seed-b1.ts', 'e2e'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoHydrated(page, '/');
  const row = page
    .getByRole('complementary', { name: 'Sidebar' })
    .locator('.muxui-sidebar__section', { hasText: 'Communities' })
    .locator('a.muxui-sidebar__nav-link')
    .first();
  const long = 'A community with a very long name indeed, from a host with a long name too';
  await row.locator('bdi').evaluate((name, text) => (name.textContent = text), long);
  await expect(row).toHaveAccessibleName(long);
  const measured = await row.evaluate((link) => {
    const label = link.querySelector<HTMLElement>('.muxui-sidebar__nav-label')!;
    const column = document.querySelector('.pb-app__side')!.getBoundingClientRect();
    return {
      column: column.width,
      columnRight: column.right,
      linkRight: link.getBoundingClientRect().right,
      cut: label.scrollWidth > label.clientWidth,
      ellipsis: getComputedStyle(label).textOverflow,
      page: document.documentElement.scrollWidth,
    };
  });
  expect(measured.column, "the column keeps Mux's open width and its hairline").toBeCloseTo((await openSize(page)) + 1, 0);
  expect(measured.linkRight, 'the row stays inside the column').toBeLessThanOrEqual(measured.columnRight);
  expect(measured.cut, 'the name is cut').toBe(true);
  expect(measured.ellipsis).toBe('ellipsis');
  expect(measured.page).toBe(1280);
});

test('a remote community whose name starts with directional controls shows a letter in its sidebar row, and its name without them', async ({
  browser,
}) => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
  const { password, people, remote } = JSON.parse(
    execFileSync('node', ['e2e/shell/seed.ts', 'remote'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as { password: string; people: [string, string]; remote: string };
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${people[0]}`, password);
  await landed(page, '/');
  // Its display name is the seed's "Shell <suffix>" after a right-to-left override and an isolate.
  const suffix = remote.slice(remote.indexOf('_') + 1);
  const row = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: `Shell ${suffix}`, exact: true });
  await expect(row).toBeVisible();
  // The avatar's initial is the first letter after the controls; the name is isolated with them taken out.
  await expect(row.locator('.muxui-avatar')).toHaveText('S');
  await expect(row.locator('bdi')).toHaveText(`Shell ${suffix}`);
});
