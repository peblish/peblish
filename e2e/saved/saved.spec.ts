import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn, signOut } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// Saved posts end to end on the lane database: the Saved page (newest save first, two pages, a removed
// post left out, axe), Unsave in place with focus and an announcement, a failed Unsave, Save on the post
// page and in a feed row's menu, a second account that sees and changes none of it, the same forms with
// scripts off, and 44px targets on a phone. The steps share one seed and run in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  suffix: string;
  owner: string;
  other: string;
  community: string;
  posts: { saved: string[]; removed: string; unsaved: string[] };
};

let seed: Seed;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-saves.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
});

const title = (n: number) => `Saved ${seed.suffix} ${String(n).padStart(2, '0')}`;
const rows = (page: Page) => page.locator('.saved-list > li');
const titles = (page: Page) => page.locator('.saved-list .pb-post__title a').allTextContents();

async function signedIn(page: Page, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await landed(page, '/');
}

/** A context signed in as `name`, with or without scripts. */
async function contextFor(browser: Browser, baseURL: string, name: string, javaScriptEnabled = true) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signedIn(page, name);
  if (javaScriptEnabled) return { context, page };
  const cookies = await context.cookies();
  const quiet = await browser.newContext({ baseURL, javaScriptEnabled: false });
  await quiet.addCookies(cookies);
  await context.close();
  return { context: quiet, page: await quiet.newPage() };
}

test('a signed-out visitor is sent to sign in and back', async ({ page }) => {
  await page.goto('/saved');
  await expect(page).toHaveURL(/\/auth\/sign-in\?redirect=%2Fsaved$/);
});

test('the Saved page: newest save first, a removed post left out, two pages, no axe violations', async ({ page }) => {
  await signedIn(page, seed.owner);
  await page.getByRole('link', { name: 'Saved', exact: true }).first().click();
  await landed(page, '/saved');
  await expect(page.getByRole('heading', { level: 1, name: 'Saved' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Saved', exact: true }).first()).toHaveAttribute('aria-current', 'page');
  expect(await titles(page)).toEqual(Array.from({ length: 20 }, (_, i) => title(21 - i)));
  await expect(page.getByText(title(22))).toHaveCount(0);
  expect(await page.content()).not.toContain(seed.posts.removed);
  await expectAccessible(page);

  await page.getByRole('link', { name: 'Older saves' }).click();
  await landed(page, /\/saved\?cursor=/);
  await expect.poll(() => titles(page)).toEqual([title(1)]);
  await expect(page.getByRole('link', { name: 'Older saves' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Newest saves' }).click();
  await landed(page, '/saved');
  await expect.poll(async () => (await titles(page)).length).toBe(20);

  // A hand-edited address is the first page, never an error page.
  for (const search of ['?cursor=123', `?cursor=${'a'.repeat(401)}`, '?cursor=%7B%7D', '?error=1']) {
    const response = await page.goto(`/saved${search}`);
    expect(response?.status()).toBe(200);
    expect(await titles(page)).toHaveLength(20);
  }
});

test('Unsave removes the row in place, moves focus to the next title and says so; a failure keeps the row', async ({ page }) => {
  await signedIn(page, seed.owner);
  await gotoHydrated(page, '/saved');

  // A failed request: the row and the focus stay, and the row says what went wrong.
  await page.route('**/saved', (route) => (route.request().method() === 'POST' ? route.abort() : route.fallback()));
  const unsave20 = page.getByRole('button', { name: `Unsave ${title(20)}` });
  await unsave20.focus();
  await page.keyboard.press('Enter');
  await expect(
    rows(page)
      .filter({ hasText: title(20) })
      .getByRole('alert'),
  ).toHaveText('Not removed from Saved. Try again.');
  await expect(unsave20).toBeFocused();
  await page.unroute('**/saved');

  await unsave20.focus();
  await page.keyboard.press('Enter');
  await expect(rows(page).filter({ hasText: title(20) })).toHaveCount(0);
  await expect(page.getByRole('link', { name: title(19), exact: true })).toBeFocused();
  await expect(page.locator('.saved-posts > [role="status"]')).toHaveText('Removed from Saved.');

  // The last row's Unsave sends focus to the one before it.
  const last = (await titles(page)).at(-1)!;
  const before = (await titles(page)).at(-2)!;
  await page.getByRole('button', { name: `Unsave ${last}` }).click();
  await expect(page.getByRole('link', { name: before, exact: true })).toBeFocused();

  await page.reload();
  await landed(page, '/saved');
  expect(await titles(page)).not.toContain(title(20));
});

test('Save on the post page: pending, then Unsave, and the post is first on the Saved page', async ({ page }) => {
  await signedIn(page, seed.owner);
  const postId = seed.posts.unsaved[0]!;
  await gotoHydrated(page, `/post/${postId}`);
  let release = () => {};
  await page.route('**/saved', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise<void>((resolve) => (release = resolve));
    await route.continue();
  });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  await expect(page.locator('form.pb-save')).toHaveAttribute('aria-busy', 'true');
  // A second press while the first is out sends nothing more.
  await save.click({ force: true });
  release();
  await expect(page.getByRole('button', { name: 'Unsave', exact: true })).toBeVisible();
  await expect(page.locator('.pb-save__status')).toHaveText('Saved.');
  await page.unroute('**/saved');

  await gotoHydrated(page, '/saved');
  expect((await titles(page))[0]).toBe(title(23));
});

test('Save in a feed row’s menu, then Unsave from the same menu', async ({ page }) => {
  await signedIn(page, seed.owner);
  // The Subscribed feed holds only the seeded community, so the post is on its first page.
  await gotoHydrated(page, '/?sort=new');
  const row = page.locator('.feed-list > li').filter({ hasText: title(24) });
  await row.getByRole('button', { name: `More actions for ${title(24)}` }).click();
  await page.getByRole('menuitem', { name: 'Save' }).click();
  await expect(row.locator('.pb-feed-row-status')).toHaveText('Saved.');
  await row.getByRole('button', { name: `More actions for ${title(24)}` }).click();
  await page.getByRole('menuitem', { name: 'Unsave' }).click();
  await expect(row.locator('.pb-feed-row-status')).toHaveText('Removed from Saved.');
});

test('a second account sees none of the first account’s saves and cannot remove them', async ({ browser, baseURL }) => {
  const { context, page } = await contextFor(browser, baseURL!, seed.other);
  await gotoHydrated(page, '/saved');
  await expect(page.getByRole('heading', { name: 'Nothing saved yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse All', exact: true })).toBeVisible();
  await expectAccessible(page);
  // The post page reads this account's own state: Save, not Unsave.
  await gotoHydrated(page, `/post/${seed.posts.saved[0]}`);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  // Unsaving the first account's post as this account changes only this account's (absent) save.
  // The browser's own fetch, as the enhanced controls post (it carries the session cookie).
  const answer = await page.evaluate(async (postId) => {
    const response = await fetch('/saved', {
      method: 'POST',
      body: new URLSearchParams({ intent: 'unsave', postId }),
      headers: { accept: 'application/json' },
    });
    return response.json();
  }, seed.posts.saved[0]!);
  expect(answer).toEqual({ saved: false });

  // This account's one save, unsaved on its Saved page: the empty state follows, and focus is on its link.
  await gotoHydrated(page, `/post/${seed.posts.saved[2]}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unsave', exact: true })).toBeVisible();
  await gotoHydrated(page, '/saved');
  expect(await titles(page)).toEqual([title(3)]);
  await page.getByRole('button', { name: `Unsave ${title(3)}` }).click();
  await expect(page.getByRole('heading', { name: 'Nothing saved yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse All', exact: true })).toBeFocused();
  await expect(page.locator('.saved-posts > [role="status"]')).toHaveText('Removed from Saved.');
  await context.close();

  // The first account's saves are still there.
  const owner = await contextFor(browser, baseURL!, seed.owner);
  await gotoHydrated(owner.page, `/post/${seed.posts.saved[0]}`);
  await expect(owner.page.getByRole('button', { name: 'Unsave', exact: true })).toBeVisible();
  await gotoHydrated(owner.page, `/post/${seed.posts.saved[2]}`);
  await expect(owner.page.getByRole('button', { name: 'Unsave', exact: true })).toBeVisible();
  await owner.context.close();
});

test('with scripts off, Save and Unsave are plain forms that come back to their page', async ({ browser, baseURL }) => {
  const { context, page } = await contextFor(browser, baseURL!, seed.owner, false);
  const postId = seed.posts.unsaved[1]!;
  await page.goto(`/post/${postId}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/post/${postId}$`));
  await expect(page.getByRole('button', { name: 'Unsave', exact: true })).toBeVisible();

  await page.goto('/saved');
  expect((await titles(page))[0]).toBe(title(24));
  await page.getByRole('button', { name: `Unsave ${title(24)}` }).click();
  await expect(page).toHaveURL(/\/saved$/);
  expect(await titles(page)).not.toContain(title(24));
  await context.close();
});

test('on a phone, Save and Unsave are 44px targets and Saved is in the menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signedIn(page, seed.owner);
  await gotoHydrated(page, '/saved');
  const unsave = rows(page)
    .first()
    .getByRole('button', { name: /^Unsave / });
  const box = (await unsave.boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  await gotoHydrated(page, `/post/${seed.posts.saved[0]}`);
  const control = (await page.getByRole('button', { name: /^(Save|Unsave)$/ }).boundingBox())!;
  expect(Math.min(control.width, control.height)).toBeGreaterThanOrEqual(44);
  // The phone reaches Saved through the drawer's navigation.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const saved = page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name: 'Saved', exact: true });
  await expect(saved).toBeVisible();
  const entry = (await saved.boundingBox())!;
  expect(entry.height).toBeGreaterThanOrEqual(44);
});

/** What the browser does when the person comes back to a tab (headless pages are always "visible", so hide it first). */
async function showAgain(page: Page): Promise<void> {
  await page.evaluate(() => {
    const set = (state: string) => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    set('hidden');
    set('visible');
  });
}

test('a feed row’s own Save is the account’s: a second press waits, and another account in another tab sees its own state', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const stale = await context.newPage();
  await signedIn(stale, seed.owner);
  await gotoHydrated(stale, '/all?sort=new');
  const row = stale.locator('.feed-list > li').filter({ hasText: title(25) });
  const more = row.getByRole('button', { name: `More actions for ${title(25)}` });

  // While the save is out the item is disabled, and nothing more is sent.
  let posts = 0;
  let release = () => {};
  await stale.route('**/saved', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts += 1;
    await new Promise<void>((resolve) => (release = resolve));
    await route.continue();
  });
  await more.click();
  await stale.getByRole('menuitem', { name: 'Save' }).click();
  await more.click();
  await expect(stale.getByRole('menuitem', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
  await stale.getByRole('menuitem', { name: 'Copy link' }).press('Escape');
  await expect(stale.getByRole('menu')).toHaveCount(0);
  release();
  await expect(row.locator('.pb-feed-row-status')).toHaveText('Saved.');
  expect(posts).toBe(1);
  await stale.unroute('**/saved');

  // Another tab signs in as the second account; the first tab, shown again, loads that account's data.
  const other = await context.newPage();
  await signOut(other);
  await gotoHydrated(other, '/auth/sign-in');
  await signIn(other, `@${seed.other}`, seed.password);
  await landed(other, '/');
  await expect.poll(() => other.evaluate(() => localStorage.getItem('pb-viewer'))).not.toBe('');
  await showAgain(stale);
  await expect(stale.getByRole('banner').getByRole('button', { name: `Account: ${seed.other}` })).toBeAttached();
  await more.click();
  await expect(stale.getByRole('menuitem', { name: 'Save', exact: true })).toBeVisible();
  await expect(stale.getByRole('menuitem', { name: 'Unsave' })).toHaveCount(0);
  await context.close();
});
