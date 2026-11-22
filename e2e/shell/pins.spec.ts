import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { galleryStates, stateProblems } from '../support/states.ts';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The sidebar's pins (f-pins): the pinned communities first in the viewer's order, a divider, then the
// rest A to Z; a pending follow marked; a pinned row's menu moving and unpinning it with focus kept and the
// change said politely; nothing moving when the page hydrates; 44px on a phone. Each test seeds its own
// person (packages/core/src/testing/seed-pins.ts) on the lane database.

type Ref = { id: string; name: string; title: string };
type Seed = {
  password: string;
  name: string;
  suffix: string;
  host: string;
  communities: Record<'ash' | 'birch' | 'cedar' | 'damson' | 'elm' | 'fir' | 'yew', Ref>;
};

const seedWorld = (): Seed =>
  JSON.parse(
    execFileSync('node', ['packages/core/src/testing/seed-pins.ts', 'e2e'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as Seed;

async function signedIn(
  browser: Browser,
  seed: Seed,
  options: { javaScriptEnabled?: boolean; viewport?: { width: number; height: number }; hasTouch?: boolean } = {},
) {
  const login = await browser.newContext();
  const first = await login.newPage();
  await gotoHydrated(first, '/auth/sign-in');
  await signIn(first, `@${seed.name}`, seed.password);
  await landed(first, '/');
  const storageState = await login.storageState();
  await login.close();
  const context = await browser.newContext({ storageState, ...options });
  return { context, page: await context.newPage() };
}

/** The column sidebar's community rows of this seed, in the order they are drawn. */
const rows = (page: Page, seed: Seed) => page.locator('.pb-side').getByRole('link').filter({ hasText: seed.suffix });
const titles = async (page: Page, seed: Seed) =>
  (await rows(page, seed).locator('bdi').allTextContents()).map((text) => text.replace(` ${seed.suffix}`, ''));
const menuOf = (scope: Page | Locator, title: string) => scope.getByRole('button', { name: `Options for ${title}` });

test.describe('seeded', () => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

  test('pinned communities come first in the viewer’s order, then a divider, then the rest A to Z; pending is marked', async ({
    browser,
  }) => {
    const seed = seedWorld();
    const { context, page } = await signedIn(browser, seed);
    await gotoHydrated(page, '/local');
    expect(await titles(page, seed)).toEqual(['Elm', 'Yew', 'Birch', 'Ash', 'Cedar', 'Damson']);
    const side = page.locator('.pb-side');
    // One divider, between Birch (the last pin) and Ash (the first of the rest).
    const divider = side.locator('li.muxui-sidebar__nav-divider, li[role="separator"]');
    await expect(divider).toHaveCount(1);
    const yew = rows(page, seed).filter({ hasText: 'Yew' });
    await expect(yew).toContainText('Pending');
    await expect(yew.locator('.pb-nav__avatar--pending')).toHaveCount(1);
    // Only pinned rows have a menu, and a community they do not follow is not listed.
    await expect(side.getByRole('button', { name: new RegExp(`^Options for .* ${seed.suffix}$`) })).toHaveCount(3);
    await expect(rows(page, seed).filter({ hasText: 'Fir' })).toHaveCount(0);
    await context.close();
  });

  test('the sidebar draws the same rows in the same places with scripts off and once hydrated', async ({ browser }) => {
    const seed = seedWorld();
    const places = async (javaScriptEnabled: boolean) => {
      const { context, page } = await signedIn(browser, seed, { javaScriptEnabled, viewport: { width: 1280, height: 900 } });
      await page.goto('/local');
      if (javaScriptEnabled) await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
      // From the sidebar's own top: without scripts the frame lists the account pages above the sidebar.
      const boxes = await rows(page, seed).evaluateAll((links) =>
        links.map((link) => Math.round(link.getBoundingClientRect().top - link.closest('nav')!.getBoundingClientRect().top)),
      );
      const list = await titles(page, seed);
      await context.close();
      return { boxes, list };
    };
    const off = await places(false);
    const on = await places(true);
    expect(on.list).toEqual(off.list);
    expect(on.boxes).toEqual(off.boxes);
    // Scripts off, the menus are gone (they cannot open); the directory's forms do their work.
    const { context, page } = await signedIn(browser, seed, { javaScriptEnabled: false });
    await page.goto('/local');
    await expect(menuOf(page.locator('.pb-side'), `Elm ${seed.suffix}`)).toBeHidden();
    await context.close();
  });

  test('a pinned row’s menu moves it and unpins it: focus stays with the row and the change is said politely', async ({ browser }) => {
    const seed = seedWorld();
    const { context, page } = await signedIn(browser, seed);
    await gotoHydrated(page, '/local');
    const side = page.locator('.pb-side');
    const status = side.locator('[aria-live="polite"]').filter({ hasText: /./ });

    // The first pin cannot move up; Move down moves it, keeps focus on its menu and says where it went.
    await menuOf(side, `Elm ${seed.suffix}`).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Move up' })).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('menuitem', { name: 'Move down' }).click();
    await expect.poll(() => titles(page, seed)).toEqual(['Yew', 'Elm', 'Birch', 'Ash', 'Cedar', 'Damson']);
    await expect(menuOf(side, `Elm ${seed.suffix}`)).toBeFocused();
    await expect(status).toHaveText(`Elm ${seed.suffix}, position 2 of 3`);

    // By keyboard alone: the menu opens on Enter, the arrows pick, Enter acts.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => titles(page, seed)).toEqual(['Yew', 'Birch', 'Elm', 'Ash', 'Cedar', 'Damson']);
    await expect(menuOf(side, `Elm ${seed.suffix}`)).toBeFocused();
    await expect(status).toHaveText(`Elm ${seed.suffix}, position 3 of 3`);

    // Unpin: the row goes back among the rest, A to Z, and focus goes to its link.
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Unpin' }).click();
    await expect.poll(() => titles(page, seed)).toEqual(['Yew', 'Birch', 'Ash', 'Cedar', 'Damson', 'Elm']);
    await expect(rows(page, seed).filter({ hasText: 'Elm' })).toBeFocused();
    await expect(status).toHaveText(`Elm ${seed.suffix} unpinned`);
    await expect(menuOf(side, `Elm ${seed.suffix}`)).toHaveCount(0);

    // The order is the account's: a fresh page draws it the same.
    await gotoHydrated(page, '/local');
    expect(await titles(page, seed)).toEqual(['Yew', 'Birch', 'Ash', 'Cedar', 'Damson', 'Elm']);
    await context.close();
  });

  test('a move from a stale tab goes the way the reader pressed, from the order as it stands, and says that place', async ({ browser }) => {
    const seed = seedWorld();
    const { context, page } = await signedIn(browser, seed);
    const stale = await context.newPage();
    for (const tab of [page, stale]) await gotoHydrated(tab, '/local');
    // One tab moves Birch up; the other still draws it last.
    await menuOf(page.locator('.pb-side'), `Birch ${seed.suffix}`).click();
    await page.getByRole('menuitem', { name: 'Move up' }).click();
    await expect.poll(() => titles(page, seed)).toEqual(['Elm', 'Birch', 'Yew', 'Ash', 'Cedar', 'Damson']);
    expect((await titles(stale, seed)).slice(0, 3)).toEqual(['Elm', 'Yew', 'Birch']);

    // Up from the stale tab takes Birch one place up from where it is now, to the top, and says so.
    const side = stale.locator('.pb-side');
    await menuOf(side, `Birch ${seed.suffix}`).click();
    await stale.getByRole('menuitem', { name: 'Move up' }).click();
    await expect.poll(() => titles(stale, seed)).toEqual(['Birch', 'Elm', 'Yew', 'Ash', 'Cedar', 'Damson']);
    await expect(menuOf(side, `Birch ${seed.suffix}`)).toBeFocused();
    await expect(side.locator('[aria-live="polite"]').filter({ hasText: /./ })).toHaveText(`Birch ${seed.suffix}, position 1 of 3`);
    await context.close();
  });

  test('on a phone the drawer’s pinned rows keep their menu, a 44px target', async ({ browser }) => {
    const seed = seedWorld();
    const { context, page } = await signedIn(browser, seed, { viewport: { width: 390, height: 844 }, hasTouch: true });
    await gotoHydrated(page, '/local');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    const menu = menuOf(drawer, `Elm ${seed.suffix}`);
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    await context.close();
  });
});

test.describe('gallery', () => {
  test.beforeEach(async ({ request }) => skipWithoutKit(request));
  test.setTimeout(240_000);

  test('/kit/sidebar-pins: open and folded, every scheme and condition passes', async ({ browser, baseURL }) => {
    const checks = await galleryStates(browser, baseURL!, '/kit/sidebar-pins');
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(['rest', 'selected', 'hover', 'focus', 'pressed']);
    // The folded rail never shows at a phone's width (the drawer opens instead, tested above), where Mux sizes
    // a row's action to the rail; the open sample takes the phone's 44px.
    expect(stateProblems(checks, { target: 44 }).filter((problem) => !/ phone selected: target /.test(problem))).toEqual([]);
  });
});
