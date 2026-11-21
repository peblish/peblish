import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The phone (below 860 px): the top bar (the frame's view header: the mark, the finder and Mux UI's
// drawer button, or Back), the bottom bar of five destinations, taps on a touch screen, where focus goes
// when a drawer link, a tab or Back changes the page, and the bars around a page shorter than the screen.
test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });

/** Lets the press that was just sent finish: every handler it starts runs within two frames. */
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const drawer = (page: Page) => page.getByRole('dialog', { name: 'Navigation' });
const opener = (page: Page) => page.getByRole('button', { name: 'Open navigation' });
const topBar = (page: Page) => page.getByRole('navigation', { name: 'Page', exact: true });
const tabs = (page: Page) => page.getByRole('navigation', { name: 'Sections' });
const focusInPage = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('#pb-main'));

/** A control's box, rounded: the phone's targets are 44px at least each way. */
const size = async (control: Locator) => {
  const box = (await control.boundingBox())!;
  return { width: Math.round(box.width), height: Math.round(box.height) };
};

test('tapping the brand on the home page does not open the drawer', async ({ page }) => {
  await gotoHydrated(page, '/');
  await page.locator('.pb-bar-brand').tap();
  await settle(page);
  await expect(drawer(page)).toHaveCount(0);
  await expect(opener(page)).toHaveAttribute('aria-expanded', 'false');
});

test('the top bar and the bottom bar are named navigations of 44px targets, the header is gone, and axe passes', async ({ page }) => {
  await gotoHydrated(page, '/');
  // The desktop header gives way: the top bar is the page's own bar, not a second banner.
  await expect(page.getByRole('banner')).toHaveCount(0);
  const bar = topBar(page);
  for (const control of [
    bar.locator('.pb-bar-brand'),
    bar.getByRole('link', { name: 'Find a community' }),
    bar.getByRole('button', { name: 'Open navigation' }),
  ]) {
    await expect(control).toBeVisible();
    const { width, height } = await size(control);
    expect(width).toBeGreaterThanOrEqual(44);
    expect(height).toBeGreaterThanOrEqual(44);
  }
  await expect(bar.getByRole('link', { name: 'Find a community' })).toHaveAttribute('href', '/communities');

  // A visitor's five: their fifth is Sign in. Home is the page shown.
  const links = tabs(page).getByRole('link');
  await expect(links).toHaveCount(5);
  for (const [index, [name, href]] of [
    ['Home', '/'],
    ['Communities', '/communities'],
    ['Create', '/submit'],
    ['Inbox', '/notifications'],
    ['Sign in', '/auth/sign-in'],
  ].entries()) {
    await expect(links.nth(index)).toHaveAccessibleName(name!);
    await expect(links.nth(index)).toHaveAttribute('href', href!);
    const { width, height } = await size(links.nth(index));
    expect(width).toBeGreaterThanOrEqual(44);
    expect(height).toBeGreaterThanOrEqual(44);
  }
  await expect(links.nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(tabs(page).locator('[aria-current]')).toHaveCount(1);
  await expectAccessible(page);
});

test('the bottom bar marks the section a page is in: another feed is under Home, a community under Communities', async ({ page }) => {
  await gotoHydrated(page, '/local');
  await expect(tabs(page).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  await tabs(page).getByRole('link', { name: 'Communities' }).tap();
  await page.waitForURL('**/communities');
  await expect(tabs(page).getByRole('link', { name: 'Communities' })).toHaveAttribute('aria-current', 'page');
  await expect(tabs(page).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current', /.*/);
  // Like a sidebar link, the tab keeps focus: the bar stays where it was.
  await expect(tabs(page).getByRole('link', { name: 'Communities' })).toBeFocused();
});

test('tapping the tab of the page shown puts the page at its top and focus on its first title, without loading it again', async ({
  page,
}) => {
  await gotoHydrated(page, '/');
  // However many posts the lane database holds, the page is several screens long.
  await page.locator('#pb-main main').evaluate((main) => {
    const spacer = document.createElement('div');
    spacer.style.blockSize = '3000px';
    spacer.dataset.testSpacer = '';
    main.append(spacer);
  });
  await page.evaluate(() => window.scrollTo(0, 2000));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
  await tabs(page).getByRole('link', { name: 'Home' }).tap();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  // Not loaded again: the spacer the page was given is still there.
  await expect(page.locator('[data-test-spacer]')).toHaveCount(1);
  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    return active?.matches('.pb-post__title a')
      ? 'title'
      : active?.matches('#pb-main main')
        ? 'main'
        : (active?.outerHTML.slice(0, 80) ?? '');
  });
  const titles = await page.locator('#pb-main main .pb-post__title a').count();
  expect(focused).toBe(titles > 0 ? 'title' : 'main');
});

test("signed in, the bottom bar's fifth is You, the inbox tab says how many are unread, and the drawer holds the account", async ({
  page,
}) => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
  const { password, people } = JSON.parse(
    execFileSync('node', ['e2e/shell/seed.ts', 'unread'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as { password: string; people: [string, string] };
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${people[0]}`, password);
  await landed(page, '/');

  const you = tabs(page).getByRole('link', { name: 'You' });
  await expect(you).toHaveAttribute('href', `/u/${people[0]}`);
  // The count is shown and spoken: "Inbox 2 unread".
  await expect(tabs(page).getByRole('link', { name: /^Inbox/ })).toHaveAccessibleName('Inbox 2 unread');
  await you.tap();
  await page.waitForURL(`**/u/${people[0]}`);
  await expect(you).toHaveAttribute('aria-current', 'page');
  await settle(page);
  await expect(drawer(page)).toHaveCount(0);

  await opener(page).tap();
  const account = drawer(page).getByRole('link', { name: 'Settings' });
  await expect(account).toBeVisible();
  expect((await size(account)).height).toBeGreaterThanOrEqual(44);
  await expect(drawer(page).getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(drawer(page).getByRole('button', { name: 'Appearance' })).toBeVisible();
});

test('a drawer link moves focus into the new page, Back then shows in the top bar, and Back with the drawer open closes it', async ({
  page,
}) => {
  await gotoHydrated(page, '/');
  await expect(topBar(page).getByRole('button', { name: 'Back' })).toHaveCount(0);
  await opener(page).click();
  await drawer(page).getByRole('link', { name: 'About', exact: true }).click();
  await page.waitForURL('**/about');
  await expect(drawer(page)).toBeHidden();
  await expect.poll(() => focusInPage(page)).toBe(true);
  await expect(page.locator('#pb-main main')).toBeFocused();
  // In place of the mark, Back: the tab's history has a page of this site before this one.
  const back = topBar(page).getByRole('button', { name: 'Back' });
  await expect(back).toBeVisible();
  expect(await size(back)).toEqual({ width: 44, height: 44 });

  await opener(page).click();
  await expect(drawer(page)).toBeVisible();
  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(drawer(page)).toBeHidden();
  await expect.poll(() => focusInPage(page)).toBe(true);

  // Back in the bar goes back too.
  await page.goForward();
  await page.waitForURL('**/about');
  await topBar(page).getByRole('button', { name: 'Back' }).tap();
  await page.waitForURL((url) => url.pathname === '/');
});

test('on a page shorter than the screen the top bar starts the page, the bottom bar ends it, and the page fills between', async ({
  page,
}) => {
  await gotoHydrated(page, '/no-such-page');
  const bar = (await topBar(page).boundingBox())!;
  const bottom = (await tabs(page).boundingBox())!;
  const main = (await page.locator('#pb-main main').boundingBox())!;
  expect(Math.round(bar.y)).toBe(0);
  expect(Math.round(bar.height)).toBeGreaterThanOrEqual(44);
  expect(Math.abs(main.y - (bar.y + bar.height))).toBeLessThan(1);
  expect(Math.abs(bottom.y + bottom.height - 800)).toBeLessThan(1);
  expect(main.y + main.height).toBeLessThanOrEqual(bottom.y + 1);
});
