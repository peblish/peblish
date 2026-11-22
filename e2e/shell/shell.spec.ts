import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { siteName } from '../support/site-name.ts';

// The application frame (Commons): the header, the sidebar and its fold into the icon rail, the centre
// column under its view header, the right rail's host, and the drawer on a phone. The phone's own bars
// are e2e/shell/phone.spec.ts; the account menu's pages are e2e/shell/account.spec.ts.

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });
const navigation = (page: Page) => sidebar(page).getByRole('navigation', { name: 'Feeds and communities' });
const fold = (page: Page) => page.getByRole('button', { name: 'Sidebar', exact: true });
/** Who has focus, by accessible name as far as a test needs it: its aria-label, else its text. */
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return (active?.getAttribute('aria-label') ?? active?.textContent ?? '').trim();
  });

test('the header holds the brand, the finder and a visitor’s Appearance, Sign in and Sign up; the sidebar the feeds, the communities and the site’s pages', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, '/');
  const banner = page.getByRole('banner');
  await expect(banner).toHaveCount(1);
  await expect(banner).toHaveAccessibleName(await siteName(page));
  await expect(banner.locator('.pb-brand')).toHaveAttribute('href', '/');
  // The finder opens the directory's community search for now; its name is a visible label, not a placeholder.
  const finder = banner.getByRole('link', { name: 'Find a community' });
  await expect(finder).toHaveAttribute('href', '/communities');
  await expect(finder).toHaveText('Find a community');
  await expect(banner.getByRole('button', { name: 'Appearance' })).toBeVisible();
  await expect(banner.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/sign-in');
  await expect(banner.getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/auth/sign-up');
  await expect(page.getByRole('link', { name: 'Create post' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Inbox/ })).toBeHidden();

  // Every row draws its icon, so Mux adds no letter mark: a link's text is its label alone.
  const nav = navigation(page);
  for (const name of ['Local', 'All', 'Popular', 'Browse all communities', 'About', 'Code of conduct', 'Privacy', 'Terms']) {
    const link = nav.getByRole('link', { name, exact: true });
    await expect(link).toBeVisible();
    expect(await link.textContent()).toBe(name);
    await expect(link.locator('svg.muxui-sidebar__nav-icon')).toHaveCount(1);
  }
  await expect(nav.getByRole('link', { name: 'Browse all communities' })).toHaveAttribute('href', '/communities');
  await expect(nav.getByRole('link', { name: 'Code of conduct' })).toHaveAttribute('href', '/rules');
  // Subscribed, Moderating and the queue need a signed-in viewer.
  for (const name of ['Subscribed', 'Moderating', 'Moderation queue']) await expect(nav.getByRole('link', { name })).toHaveCount(0);
});

test('the centre column sits in the middle of what the sidebar leaves, and the sign-in card in the middle of the column', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, '/');
  await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).click();
  await landed(page, '**/auth/sign-in');
  // The sign-in form, flat in the column since the account pages moved into the Commons form layout. The address
  // changes before the page does, so the frame is measured once the form is there (the feed before it has a rail).
  const form = page.getByRole('main').getByRole('form', { name: 'Sign in' });
  await expect(form).toBeVisible();
  const side = (await sidebar(page).boundingBox())!;
  const centre = (await page.locator('#pb-main').boundingBox())!;
  const card = (await form.boundingBox())!;
  const middle = (box: { x: number; width: number }) => box.x + box.width / 2;
  // The default width: a 40rem column between its hairlines.
  expect(Math.round(centre.width)).toBe(642);
  expect(Math.abs(middle(centre) - (side.x + side.width + 1440) / 2)).toBeLessThan(2);
  expect(Math.abs(middle(card) - middle(centre))).toBeLessThan(2);
});

test('the keyboard reaches the skip link, the header, the fold and the sidebar in that order, and the skip link moves past them', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Not the home page: a Mux Link's same-page # once resolved against the site root.
  await gotoHydrated(page, '/communities');
  const stops: string[] = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    stops.push(await focusedName(page));
  }
  const site = await siteName(page);
  expect(stops).toEqual([
    'Skip to content',
    site,
    'Find a community',
    'Appearance',
    'Sign in',
    'Sign up',
    'Sidebar',
    'Local',
    'All',
    'Popular',
  ]);

  // The skip link moves focus past all of that, and stays on the page.
  await gotoHydrated(page, '/communities');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#pb-main')).toBeFocused();
  expect(new URL(page.url()).pathname).toBe('/communities');
});

test('the sidebar folds into the icon rail and back from the keyboard; the server draws the choice, and folded rows keep their names', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, '/');
  const side = page.locator('.pb-side');
  await expect(side).not.toHaveAttribute('data-muxui-collapsed', /.*/);
  await expect(fold(page)).toHaveAttribute('aria-expanded', 'true');
  await fold(page).focus();
  // The tooltip says what a press does; the button's name stays "Sidebar".
  await expect(page.getByRole('tooltip')).toHaveText('Collapse sidebar');
  await page.keyboard.press('Enter');
  await expect(side).toHaveAttribute('data-muxui-collapsed', '');
  await expect(fold(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(fold(page)).toBeFocused();
  await expect.poll(async () => Math.round((await side.boundingBox())!.width)).toBeLessThan(80);
  expect((await page.context().cookies()).find((cookie) => cookie.name === 'peblish_side')?.value).toBe('rail');

  // Folded, a row is its icon: its name stays for assistive tech, and focus or hover shows it in a tooltip.
  const local = navigation(page).getByRole('link', { name: 'Local', exact: true });
  await expect(local).toHaveAccessibleName('Local');
  await local.focus();
  await expect(page.getByRole('tooltip')).toHaveText('Local');

  // The choice is in the server's render: a reload draws the rail at once.
  const html = await (await page.context().request.get('/')).text();
  expect(html).toMatch(/<aside[^>]*\bpb-side\b[^>]*data-muxui-collapsed|<aside[^>]*data-muxui-collapsed[^>]*\bpb-side\b/);
  await gotoHydrated(page, '/');
  await expect(page.locator('.pb-side')).toHaveAttribute('data-muxui-collapsed', '');

  await fold(page).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.pb-side')).not.toHaveAttribute('data-muxui-collapsed', /.*/);
  expect((await page.context().cookies()).find((cookie) => cookie.name === 'peblish_side')?.value).toBe('open');
});

test('until the visitor chooses, the sidebar follows the window: folded below 1264 px, open from there', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await gotoHydrated(page, '/');
  const side = page.locator('.pb-side');
  await expect(side).toHaveAttribute('data-muxui-collapsed', '');
  await page.setViewportSize({ width: 1300, height: 800 });
  await expect(side).not.toHaveAttribute('data-muxui-collapsed', /.*/);
  // A choice holds whatever the width.
  await fold(page).click();
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(side).toHaveAttribute('data-muxui-collapsed', '');
});

test("the sidebar's sections fold from their titles, open in the server's page, and stay as the viewer left them in this browser", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, '/');
  const nav = navigation(page);
  const title = () => nav.getByRole('button', { name: 'Communities' });
  const browse = () => nav.getByRole('link', { name: 'Browse all communities' });
  await expect(title()).toHaveAttribute('aria-expanded', 'true');
  await expect(browse()).toBeVisible();
  await title().focus();
  await page.keyboard.press('Enter');
  await expect(title()).toHaveAttribute('aria-expanded', 'false');
  await expect(browse()).toBeHidden();
  await expect(title()).toBeFocused();
  // Every section is open in the server's page: none is closed before its title works, or with scripts off.
  const html = await (await page.context().request.get('/')).text();
  expect(html).not.toMatch(/<ul[^>]*muxui-sidebar__section-items[^>]*hidden/);
  // The fold is remembered in this browser.
  await gotoHydrated(page, '/');
  await expect(title()).toHaveAttribute('aria-expanded', 'false');
  await expect(browse()).toBeHidden();
  // Folded into the rail, every section's rows show, and the titles are no buttons.
  await fold(page).click();
  await expect(browse()).toBeVisible();
  await expect(title()).toHaveCount(0);
  await fold(page).click();
  await title().click();
  await expect(browse()).toBeVisible();
});

test("folded into the rail, the site's pages are one menu at the rail's foot, named by the site", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, '/');
  const site = await siteName(page);
  // Open, the site's name titles its section (a button that folds it); the menu is only the folded rail's.
  const menu = sidebar(page).locator('.pb-side__foot').getByRole('button', { name: site, exact: true });
  await expect(menu).toHaveCount(0);
  await fold(page).focus();
  await page.keyboard.press('Enter');
  // The section's rows give way to the menu at the foot, outside the scrolling list.
  await expect(navigation(page).getByRole('link', { name: 'Privacy' })).toBeHidden();
  await expect(menu).toBeVisible();
  await menu.focus();
  await expect(page.getByRole('tooltip')).toHaveText(site);
  await page.keyboard.press('Enter');
  const items = page.getByRole('menu', { name: site }).getByRole('menuitem');
  await expect(items).toHaveText(['About', 'Code of conduct', 'Privacy', 'Terms']);
  await page.getByRole('menuitem', { name: 'Privacy' }).click();
  await landed(page, '**/privacy');
});

test('the right rail a route puts beside its main sits beside the centre, and gives way where the page is narrower than 62rem', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, '/communities');
  // No route fills the rail yet: one is put in place as a route would render it.
  await page.locator('#pb-main').evaluate((frame) => {
    const rail = document.createElement('aside');
    rail.className = 'pb-rail';
    rail.setAttribute('aria-label', 'About this place');
    rail.textContent = 'Rail';
    frame.append(rail);
  });
  const rail = page.getByRole('complementary', { name: 'About this place' });
  const main = page.locator('#pb-main main');
  await expect(rail).toBeVisible();
  const [railBox, mainBox] = [(await rail.boundingBox())!, (await main.boundingBox())!];
  expect(Math.round(railBox.width)).toBe(312);
  expect(railBox.x).toBeGreaterThanOrEqual(mainBox.x + mainBox.width - 1);
  // Folded, the page is still wide enough at 1100 px.
  await fold(page).click();
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(rail).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(rail).toBeHidden();
  expect(Math.round((await main.boundingBox())!.width)).toBeLessThanOrEqual(640);
});

test("the view header shows Back once the tab can go back, and the page's name once its heading has scrolled under", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoHydrated(page, '/');
  const bar = page.getByRole('navigation', { name: 'Page', exact: true });
  await expect(bar.getByRole('button', { name: 'Back' })).toHaveCount(0);
  await navigation(page).getByRole('link', { name: 'About', exact: true }).click();
  await landed(page, '**/about');
  // The name stays out of the bar while the page's own heading is in view.
  await expect(bar.locator('.pb-vh__title')).toHaveAttribute('data-quiet', 'true');
  await page.locator('#pb-main main').evaluate((main) => {
    const spacer = document.createElement('div');
    spacer.style.blockSize = '3000px';
    main.append(spacer);
  });
  await page.evaluate(() => window.scrollTo(0, 1500));
  await expect(bar.locator('.pb-vh__title')).not.toHaveAttribute('data-quiet', /.*/);
  await expect(bar.locator('.pb-vh__title')).toHaveText(new RegExp(`^${await page.title().then((title) => title.split(' · ')[0])}$`));
  await bar.getByRole('button', { name: 'Back' }).click();
  await page.waitForURL((url) => url.pathname === '/');
});

test("the site's pages at the sidebar's foot can be reached on a short window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await gotoHydrated(page, '/');
  const terms = navigation(page).getByRole('link', { name: 'Terms', exact: true });
  await terms.scrollIntoViewIfNeeded();
  await expect(terms).toBeInViewport();
  await terms.click();
  await page.waitForURL('**/terms');
});

test('signed in, the header has Create post, the inbox with its unread count said in words, and an account menu holding Appearance', async ({
  page,
}) => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
  const { password, people } = JSON.parse(
    execFileSync('node', ['e2e/shell/seed.ts', 'unread'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as { password: string; people: [string, string] };
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${people[0]}`, password);
  await landed(page, '/');
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('link', { name: 'Create post' })).toHaveAttribute('href', '/submit');
  const inbox = banner.getByRole('link', { name: /^Inbox/ });
  await expect(inbox).toHaveAccessibleName('Inbox 2 unread');
  await expect(inbox).toHaveAttribute('href', '/notifications');
  await expect(navigation(page).getByRole('link', { name: 'Subscribed' })).toHaveAttribute('aria-current', 'page');

  await banner.getByRole('button', { name: `Account: ${people[0]}` }).click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
  // Appearance lives in the account menu: the current choice is ticked and described so.
  await expect(menu.getByRole('menuitem', { name: 'System' })).toHaveAccessibleDescription('current');
  await expect(menu.getByRole('menuitem', { name: 'Dark' })).toHaveAccessibleDescription('');
  await menu.getByRole('menuitem', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'dark');
  await banner.getByRole('button', { name: `Account: ${people[0]}` }).click();
  await expect(page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Dark' })).toHaveAccessibleDescription('current');
});

test('an unknown address answers with the frame and a page not found message', async ({ page }) => {
  await gotoHydrated(page, '/no-such-page');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page).toHaveTitle(`Page not found · ${await siteName(page)}`);
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

test("on a phone the sidebar is Mux UI's drawer behind the top bar's menu button, with Appearance at its foot", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await gotoHydrated(page, '/');
  await expect(sidebar(page)).toBeHidden();
  // Mux UI names the button and the drawer in English in every locale (rc.7).
  const open = page.getByRole('button', { name: 'Open navigation' });
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await open.click();
  await expect(
    drawer.getByRole('navigation', { name: 'Feeds and communities' }).getByRole('link', { name: 'Local', exact: true }),
  ).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer.getByRole('button', { name: 'Appearance' })).toBeVisible();
  // Its rows are 44px targets.
  expect(Math.round((await drawer.getByRole('link', { name: 'Terms', exact: true }).boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  // Focus moved into the drawer; Escape closes it and gives focus back to the button.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(open).toBeFocused();

  // A link in the drawer navigates and closes it; Back does not bring it back.
  await open.click();
  await drawer.getByRole('link', { name: 'About', exact: true }).click();
  await page.waitForURL('**/about');
  await expect(drawer).toBeHidden();
  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(drawer).toBeHidden();
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

test('with System chosen, an open appearance popover follows an OS scheme change', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await gotoHydrated(page, '/');
  await page.getByRole('banner').getByRole('button', { name: 'Appearance' }).click();
  const choices = page.getByRole('radiogroup', { name: 'Appearance' });
  await expect(choices.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
  // The popover is an inverse surface: its contents take the scheme opposite the page's.
  const scope = choices.locator('xpath=ancestor::*[@data-muxui-color-scheme][1]');
  await expect(scope).toHaveAttribute('data-muxui-color-scheme', 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'dark');
  await expect(choices).toBeVisible();
  await expect(scope).toHaveAttribute('data-muxui-color-scheme', 'light');
});

test.describe('with reduced motion', () => {
  test('the sidebar folds at once, with no animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoHydrated(page, '/');
    await fold(page).click();
    const width = await page.locator('.pb-side').evaluate((side) => Math.round(side.getBoundingClientRect().width));
    expect(width).toBeLessThan(80);
    expect(await page.locator('.pb-side').evaluate((side) => side.getAnimations().length)).toBe(0);
  });
});

test.describe('under forced colours', () => {
  test("the bottom bar's current tab is underlined, not told by colour alone, and the frame's focus is drawn", async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.setViewportSize({ width: 390, height: 800 });
    await gotoHydrated(page, '/');
    const tabs = page.getByRole('navigation', { name: 'Sections' });
    const line = (name: string) =>
      tabs
        .getByRole('link', { name })
        .locator('.pb-tabbar__label')
        .evaluate((label) => getComputedStyle(label).textDecorationLine);
    expect(await line('Home')).toBe('underline');
    expect(await line('Communities')).toBe('none');
    await page.keyboard.press('Tab');
    await tabs.getByRole('link', { name: 'Communities' }).focus();
    const outline = await tabs
      .getByRole('link', { name: 'Communities' })
      .evaluate((link) => `${getComputedStyle(link).outlineStyle} ${getComputedStyle(link).outlineWidth}`);
    expect(outline).toBe('solid 2px');
  });
});
