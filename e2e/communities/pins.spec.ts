import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The directory's pin controls (f-pins): Pin before Join on the rows the viewer follows or asked to join,
// and the pinned group above the list with Move up and Move down, hydrated (focus kept, the change said
// politely, the sidebar in step) and as plain forms with scripts off. Each test seeds its own person
// (packages/core/src/testing/seed-pins.ts) on the lane database; the gallery pages cover every state.

type Ref = { id: string; name: string; title: string };
type Seed = {
  password: string;
  name: string;
  suffix: string;
  communities: Record<'ash' | 'birch' | 'cedar' | 'damson' | 'elm' | 'fir' | 'yew', Ref>;
};

const seedWorld = (): Seed =>
  JSON.parse(
    execFileSync('node', ['packages/core/src/testing/seed-pins.ts', 'e2e'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as Seed;

/** The pins world with Oak, a sensitive local community, pinned last, Yew's host blocked here, and Birch out of the directory (e2e/shell/pins-seed.ts). */
const seedGated = (): Seed =>
  JSON.parse(
    execFileSync('node', ['e2e/shell/pins-seed.ts', 'gated'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as Seed;

async function signedIn(browser: Browser, seed: Seed, javaScriptEnabled = true) {
  const login = await browser.newContext();
  const first = await login.newPage();
  await gotoHydrated(first, '/auth/sign-in');
  await signIn(first, `@${seed.name}`, seed.password);
  await landed(first, '/');
  const storageState = await login.storageState();
  await login.close();
  const context = await browser.newContext({ storageState, javaScriptEnabled });
  return { context, page: await context.newPage() };
}

/** Starts keeping every text the region takes, from now on; `said` reads them, empty ones and repeats left out. */
const listen = (live: Locator) =>
  live.evaluate((region) => {
    const w = window as Window & { said?: string[] };
    w.said = [];
    new MutationObserver(() => w.said!.push(region.textContent ?? '')).observe(region, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
const said = (page: Page) =>
  page.evaluate(() =>
    ((window as Window & { said?: string[] }).said ?? []).filter((text, index, all) => text !== '' && text !== all[index - 1]),
  );

const group = (page: Page) => page.getByRole('region', { name: 'Pinned' });
/** The pinned group's titles in order, without the seed's suffix. */
const order = async (page: Page, seed: Seed) =>
  (await group(page).getByRole('list', { name: 'Your pinned communities' }).locator('.pb-clist__title').allTextContents()).map((text) =>
    text.replace(` ${seed.suffix}`, ''),
  );
const sidebarOrder = async (page: Page, seed: Seed) =>
  (await page.locator('.pb-side bdi').filter({ hasText: seed.suffix }).allTextContents()).map((text) =>
    text.replace(` ${seed.suffix}`, ''),
  );

test.describe('seeded', () => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

  test('Pin is offered on followed and pending rows only, and pins at the end of the group and the sidebar', async ({ browser }) => {
    const seed = seedWorld();
    const { context, page } = await signedIn(browser, seed);
    await gotoHydrated(page, `/communities?q=${seed.suffix}`);
    const list = page.getByRole('main').getByRole('list', { name: 'Communities' });
    const pin = (title: string) => list.getByRole('button', { name: `Pin ${title} ${seed.suffix}` });
    await expect(pin('Elm')).toHaveAttribute('aria-pressed', 'true');
    await expect(pin('Damson')).toHaveAttribute('aria-pressed', 'false');
    await expect(pin('Fir')).toHaveCount(0);
    // A search hides the group: it is the viewer's own list, not a result.
    await expect(group(page)).toHaveCount(0);

    // Damson sorts last of the unpinned rows, so pinning it moves it in the sidebar: up to the end of the pins,
    // with a menu of its own, and unpinning puts it back.
    const sideMenu = page.locator('.pb-side').getByRole('button', { name: `Options for Damson ${seed.suffix}` });
    await expect(sideMenu).toHaveCount(0);
    await pin('Damson').focus();
    await page.keyboard.press('Enter');
    await expect(pin('Damson')).toHaveAttribute('aria-pressed', 'true');
    await expect(pin('Damson')).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: `Damson ${seed.suffix} pinned` })).toHaveCount(1);
    await expect.poll(() => sidebarOrder(page, seed)).toEqual(['Elm', 'Yew', 'Birch', 'Damson', 'Ash', 'Cedar']);
    await expect(sideMenu).toHaveCount(1);

    await page.keyboard.press('Space');
    await expect(pin('Damson')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => sidebarOrder(page, seed)).toEqual(['Elm', 'Yew', 'Birch', 'Ash', 'Cedar', 'Damson']);
    await expect(sideMenu).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: `Damson ${seed.suffix} unpinned` })).toHaveCount(1);
    await context.close();
  });

  test('the pinned group moves a row up and down: focus stays on the button, or hops at an end, and the place is said', async ({
    browser,
  }) => {
    const seed = seedWorld();
    const { context, page } = await signedIn(browser, seed);
    await gotoHydrated(page, '/communities');
    expect(await order(page, seed)).toEqual(['Elm', 'Yew', 'Birch']);
    const button = (name: string) => group(page).getByRole('button', { name: `${name.replace('$', seed.suffix)}` });
    // The page's status, beside the group: it outlives the group's last pin.
    const status = page.getByRole('main').getByRole('status').filter({ hasText: seed.suffix });
    await expect(button('Move Elm $ up')).toBeDisabled();
    await expect(button('Move Birch $ down')).toBeDisabled();

    await button('Move Elm $ down').click();
    await expect.poll(() => order(page, seed)).toEqual(['Yew', 'Elm', 'Birch']);
    await expect(button('Move Elm $ down')).toBeFocused();
    await expect(status).toHaveText(`Elm ${seed.suffix}, position 2 of 3`);
    await expect.poll(() => sidebarOrder(page, seed)).toEqual(['Yew', 'Elm', 'Birch', 'Ash', 'Cedar', 'Damson']);

    // At the end Move down disables, so focus goes to Move up.
    await page.keyboard.press('Enter');
    await expect.poll(() => order(page, seed)).toEqual(['Yew', 'Birch', 'Elm']);
    await expect(button('Move Elm $ up')).toBeFocused();
    await expect(status).toHaveText(`Elm ${seed.suffix}, position 3 of 3`);

    // Unpinning from the group: the row leaves it, and focus goes to its Pin in the list below, or to the
    // group's heading when the community is not on this page of the list.
    await group(page)
      .getByRole('button', { name: `Pin Elm ${seed.suffix}` })
      .click();
    await expect.poll(() => order(page, seed)).toEqual(['Yew', 'Birch']);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id ?? ''))
      .toMatch(new RegExp(`^(dir-pin-${seed.communities.elm.id}|.*-title)$`));
    await expect(status).toHaveText(`Elm ${seed.suffix} unpinned`);
    await context.close();
  });

  test('the last Unpin in the group is still said, and a retry after a failure says its own outcome only', async ({ browser }) => {
    const seed = seedWorld();
    const { context, page } = await signedIn(browser, seed);
    await gotoHydrated(page, '/communities');
    const button = (name: string) => group(page).getByRole('button', { name: name.replace('$', seed.suffix) });
    // The page's own pin status, beside the group (a row's Pin has one of its own).
    const status = page.locator('main > [role="status"]');
    await button('Move Elm $ down').click();
    await expect(status).toHaveText(`Elm ${seed.suffix}, position 2 of 3`);
    await page.route('**/communities/pins', (route) => route.fulfill({ status: 500, json: { error: 'generic' } }));
    await button('Move Elm $ down').click();
    await expect(group(page).getByRole('alert')).toHaveText('That did not work. Try again.');
    await page.unroute('**/communities/pins');
    await listen(status);
    await button('Move Elm $ down').click();
    await expect.poll(() => order(page, seed)).toEqual(['Yew', 'Birch', 'Elm']);
    await expect(status).toHaveText(`Elm ${seed.suffix}, position 3 of 3`);
    expect(await said(page)).toEqual([`Elm ${seed.suffix}, position 3 of 3`]);

    // The same words twice are said twice: unpin Elm, pin it again from its own row, unpin it again.
    await page.goto(`/communities?sort=newest`);
    await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    const row = page
      .getByRole('main')
      .getByRole('list', { name: 'Communities', exact: true })
      .getByRole('button', { name: `Pin Elm ${seed.suffix}` });
    await button('Pin Elm $').click();
    await expect(status).toHaveText(`Elm ${seed.suffix} unpinned`);
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await listen(status);
    await button('Pin Elm $').click();
    await expect.poll(() => said(page)).toEqual([`Elm ${seed.suffix} unpinned`]);

    // Elm is unpinned now: the last two go, and the last Unpin is said too.
    for (const title of ['Yew', 'Birch']) {
      await button(`Pin ${title} $`).click();
      await expect(status).toHaveText(`${title} ${seed.suffix} unpinned`);
    }
    await expect(group(page)).toHaveCount(0);
    await context.close();
  });

  test('the group keeps to the directory’s scope: Local leaves the remote pin out and keeps the local ones', async ({ browser }) => {
    const seed = seedWorld();
    const { context, page } = await signedIn(browser, seed);
    await gotoHydrated(page, '/communities?scope=local');
    expect(await order(page, seed)).toEqual(['Elm', 'Birch']);
    await expect(group(page).getByText(seed.communities.yew.name)).toHaveCount(0);
    // A move goes one place in the whole order, the sidebar's, so past a pin the scope hides it would seem to do
    // nothing: with a pin hidden the group offers no moves, and Unpin stays.
    await expect(group(page).getByRole('button', { name: /^Move / })).toHaveCount(0);
    await expect(group(page).getByRole('button', { name: `Pin Birch ${seed.suffix}` })).toHaveAttribute('aria-pressed', 'true');
    await gotoHydrated(page, '/communities');
    expect(await order(page, seed)).toEqual(['Elm', 'Yew', 'Birch']);
    await expect(group(page).getByRole('button', { name: /^Move / })).toHaveCount(6);
    await context.close();
  });

  // The directory's own rules, applied to the viewer's pins (directory/read.ts, listedPins): a host this server
  // blocks and the age gate hide a pin, as the list hides the community; the directory opt-out does not, as the
  // reader chose the community already. A pin those rules hide takes the group's moves away too, as the scope's does.
  test('the group leaves out a pin whose host this server blocks, and a sensitive one for a viewer who has not declared 16+', async ({
    browser,
  }) => {
    const seed = seedGated();
    const { context, page } = await signedIn(browser, seed);
    await gotoHydrated(page, '/communities');
    // Birch opted out of the directory and stays.
    expect(await order(page, seed)).toEqual(['Elm', 'Birch']);
    await expect(group(page).getByRole('button', { name: /^Move / })).toHaveCount(0);
    await expect(group(page).getByRole('button', { name: `Pin Birch ${seed.suffix}` })).toHaveAttribute('aria-pressed', 'true');
    await context.close();
  });

  test('with scripts off, Pin and the moves are plain forms that come back to the page', async ({ browser }) => {
    const seed = seedWorld();
    const { context, page } = await signedIn(browser, seed, false);
    await page.goto('/communities');
    expect(await order(page, seed)).toEqual(['Elm', 'Yew', 'Birch']);
    await group(page)
      .getByRole('button', { name: `Move Birch ${seed.suffix} up` })
      .click();
    await page.waitForURL('/communities');
    expect(await order(page, seed)).toEqual(['Elm', 'Birch', 'Yew']);

    await page.goto(`/communities?q=${seed.suffix}`);
    await page.getByRole('button', { name: `Pin Damson ${seed.suffix}` }).click();
    await page.waitForURL(`/communities?q=${seed.suffix}`);
    await expect(page.getByRole('button', { name: `Pin Damson ${seed.suffix}` })).toHaveAttribute('aria-pressed', 'true');
    await page.goto('/communities');
    expect(await order(page, seed)).toEqual(['Elm', 'Birch', 'Yew', 'Damson']);
    await context.close();
  });

  test('with scripts off, a move from a stale page goes the way the reader pressed, from the order as it stands', async ({ browser }) => {
    const seed = seedWorld();
    const { context, page } = await signedIn(browser, seed, false);
    const stale = await context.newPage();
    for (const tab of [page, stale]) await tab.goto('/communities');
    const up = (tab: Page, title: string) => group(tab).getByRole('button', { name: `Move ${title} ${seed.suffix} up` });
    await up(page, 'Birch').click();
    await page.waitForURL('/communities');
    expect(await order(page, seed)).toEqual(['Elm', 'Birch', 'Yew']);

    // The stale page still draws Birch last; its Move up takes Birch one place up from where it is now.
    expect(await order(stale, seed)).toEqual(['Elm', 'Yew', 'Birch']);
    await up(stale, 'Birch').click();
    await stale.waitForURL('/communities');
    expect(await order(stale, seed)).toEqual(['Birch', 'Elm', 'Yew']);
    await context.close();
  });
});

test.describe('gallery', () => {
  test.beforeEach(async ({ request }) => skipWithoutKit(request));
  test.setTimeout(240_000);

  const compositions: Record<string, string[]> = {
    'pin-toggle': ['rest', 'selected', 'pending', 'invalid', 'hover', 'focus', 'pressed'],
    'pin-move': ['rest', 'disabled', 'pending', 'hover', 'focus', 'pressed'],
    'pinned-group': ['rest', 'selected', 'hover', 'focus', 'pressed'],
  };
  for (const [composition, states] of Object.entries(compositions)) {
    test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
      const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
      expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
      expect(stateProblems(checks, { target: 44 })).toEqual([]);
    });
  }

  test('Pin says what it is and whether it is on; Move up and Move down name the community', async ({ page }) => {
    await gotoHydrated(page, '/kit/pin-toggle');
    await expect(page.locator('[data-kit-state="rest"]').getByRole('button', { name: 'Pin Tide pools' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.locator('[data-kit-state="selected"]').getByRole('button', { name: 'Pin Tide pools' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('[data-kit-state="invalid"]').getByRole('alert')).toHaveText('That did not work. Try again.');
    await gotoHydrated(page, '/kit/pin-move');
    await expect(page.locator('[data-kit-state="disabled"]').getByRole('button', { name: 'Move Loomwork up' })).toBeDisabled();
    await expect(page.locator('[data-kit-state="pending"]').getByRole('button', { name: 'Move Loomwork down' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });
});
