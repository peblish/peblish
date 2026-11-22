import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type BrowserContextOptions, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The Commons thread end to end on the lane database: a fold keeps focus and lasts the visit, a tombstone shows no
// author, a refused reply says why, the docked reply never covers what has focus, the comment menu copies and shares
// a comment's address, a phone's targets are 44 px, and without scripts the controls that need them are gone while
// the reply form stays. The tree's and the dock's states are in thread-states.spec.ts.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  suffix: string;
  replier: { name: string };
  posts: { thread: string; tombstones: string; locked: string; paged: string };
  comments: { first: string; second: string; third: string; deleted: string; removed: string };
};

let seed: Seed;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-d.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
});

const postUrl = (id: string) => `/post/${id}`;
const commentUrl = (postId: string, commentId: string) => `/post/${postId}/comments/${commentId}`;
const row = (page: Page, id: string) => page.locator(`#comment-${id}`);
const head = (page: Page, id: string) => row(page, id).locator('> .pb-comment__head');
const fold = (page: Page, id: string) => head(page, id).locator('> .pb-comment__fold');
const actions = (page: Page, id: string) => row(page, id).locator('> .pb-comment__main > .pb-comment__actions');
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, hasTouch: true };

async function signedIn(page: Page, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await landed(page, '/');
}

test('a fold keeps focus on its button, says whether it is open, and lasts the visit', async ({ page }) => {
  await gotoHydrated(page, postUrl(seed.posts.thread));
  const button = fold(page, seed.comments.second);
  const chain = page.getByText(`Chain level 2 ${seed.suffix}`);
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(button).toHaveAccessibleName(/^Collapse comment and \d+ replies$/);
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toHaveAccessibleName(/^Expand comment and \d+ replies$/);
  await expect(button).toBeFocused();
  await expect(chain).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(button).toBeFocused();
  await expect(chain).toBeVisible();

  // Folded, then off to the community and Back in the same document: still folded. A new visit starts open.
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => Object.assign(window, { sameVisit: true }));
  await page.getByRole('link', { name: /^Post in / }).click();
  await page.waitForURL(/\/c\//);
  await page.goBack();
  await page.waitForURL(new RegExp(`${postUrl(seed.posts.thread)}$`));
  await expect(fold(page, seed.comments.second)).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => (window as unknown as { sameVisit?: boolean }).sameVisit)).toBe(true);
  await page.reload();
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await expect(fold(page, seed.comments.second)).toHaveAttribute('aria-expanded', 'true');
});

test('a tombstone shows neither its author nor its text, on the page or in the data sent with it', async ({ page }) => {
  // The deleted and the removed comment are the replier's, who wrote nothing else under this post.
  const response = await page.goto(postUrl(seed.posts.tombstones), { waitUntil: 'commit' });
  expect(await response!.text()).not.toContain(seed.replier.name);
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  for (const [id, label] of [
    [seed.comments.deleted, '[deleted]'],
    [seed.comments.removed, '[removed by a moderator]'],
  ] as const) {
    await expect(row(page, id)).toHaveAttribute('data-tombstone', 'true');
    await expect(head(page, id)).toContainText(label);
    await expect(head(page, id).getByRole('link')).toHaveCount(0);
    await expect(row(page, id).locator('> .pb-comment__main > .pb-comment__text')).toHaveCount(0);
    await expect(actions(page, id).getByRole('button')).toHaveCount(0);
  }
});

test('where a reply is refused, the dock’s place says why and no comment offers Reply', async ({ page }) => {
  const notice = page.locator('.th-notice');
  const replies = page.locator('.pb-comment__reply');
  await gotoHydrated(page, postUrl(seed.posts.thread));
  await expect(notice).toHaveText('Sign in to comment. Sign in');
  await expect(notice.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    `/auth/sign-in?redirect=${encodeURIComponent(postUrl(seed.posts.thread))}`,
  );
  await expect(page.getByRole('form', { name: 'Reply' })).toHaveCount(0);
  await expect(replies).toHaveCount(0);

  // Locked, for a signed-in person too, with the lock beside the reason.
  await signedIn(page, seed.replier.name);
  await gotoHydrated(page, postUrl(seed.posts.locked));
  await expect(notice).toHaveText('This post is locked. It takes no new comments.');
  await expect(notice.locator('svg')).toHaveCount(1);
  await expect(page.getByRole('form', { name: 'Reply' })).toHaveCount(0);
  await expect(replies).toHaveCount(0);
});

for (const [where, options] of [
  ['a desktop', { viewport: { width: 1280, height: 720 } }],
  ['a phone', phone],
] as const) {
  test(`the docked reply never covers what has focus, on ${where}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ ...options, baseURL });
    const page = await context.newPage();
    await signedIn(page, seed.replier.name);
    await gotoHydrated(page, postUrl(seed.posts.thread));
    await fold(page, seed.comments.first).focus();
    let steps = 0;
    for (; steps < 80; steps += 1) {
      await page.keyboard.press('Tab');
      const seen = await page.evaluate(() => {
        const focused = document.activeElement;
        const dock = document.querySelector('.pb-reply');
        if (!focused || !dock || dock.contains(focused)) return null;
        const box = focused.getBoundingClientRect();
        const name = focused.getAttribute('aria-label') ?? focused.textContent?.trim() ?? focused.tagName;
        return { name, top: box.top, bottom: box.bottom, dock: dock.getBoundingClientRect().top };
      });
      if (!seen) break;
      expect(seen.bottom, `${seen.name}: under the dock`).toBeLessThanOrEqual(seen.dock + 0.5);
      expect(seen.top, `${seen.name}: above the window`).toBeGreaterThanOrEqual(0);
    }
    // Through the thread, and into the dock at its end.
    expect(steps).toBeGreaterThan(10);
    await expect(page.getByRole('form', { name: 'Reply' }).getByRole('textbox', { name: 'Reply' })).toBeFocused();
    await context.close();
  });
}

test.describe('the comment menu', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('Copy link puts the comment’s address on the clipboard and says so, and focus goes back to More actions', async ({
    page,
    baseURL,
  }) => {
    await gotoHydrated(page, postUrl(seed.posts.thread));
    const more = actions(page, seed.comments.third).getByRole('button', { name: 'More actions' });
    await more.click();
    const menu = page.getByRole('menu', { name: 'Comment actions' });
    await menu.getByRole('menuitem', { name: 'Copy link' }).click();
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      new URL(commentUrl(seed.posts.thread, seed.comments.third), baseURL).href,
    );
    await expect(actions(page, seed.comments.third).getByText('Link copied.')).toBeVisible();
    await expect(page.locator('.pb-thread > [role="status"]')).toHaveText('Link copied.');
  });

  test('Share hands the comment’s address to the share sheet, and closing the sheet is no failure', async ({ page, baseURL }) => {
    await page.addInitScript(() => {
      const shared: unknown[] = [];
      Object.assign(window, { shared });
      // The first share goes through; the reader closes the second sheet.
      Object.defineProperty(Navigator.prototype, 'share', {
        configurable: true,
        value: async (data: unknown) => {
          shared.push(data);
          if (shared.length > 1) throw new DOMException('Share canceled', 'AbortError');
        },
      });
    });
    await gotoHydrated(page, postUrl(seed.posts.thread));
    const more = actions(page, seed.comments.third).getByRole('button', { name: 'More actions' });
    for (let time = 0; time < 2; time += 1) {
      await more.click();
      await page.getByRole('menu', { name: 'Comment actions' }).getByRole('menuitem', { name: 'Share' }).click();
      await expect(more).toBeFocused();
    }
    const url = new URL(commentUrl(seed.posts.thread, seed.comments.third), baseURL).href;
    expect(await page.evaluate(() => (window as unknown as { shared: unknown[] }).shared)).toEqual([{ url }, { url }]);
    await expect(page.locator('.pb-thread > [role="status"]')).toHaveText('');
    await expect(actions(page, seed.comments.third).locator('.pb-comment__notice')).toHaveCount(0);
  });
});

test('on a phone every control of a post, its thread and a comment’s page is a 44 px target', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...phone, baseURL });
  const page = await context.newPage();
  await signedIn(page, seed.replier.name);
  for (const path of [postUrl(seed.posts.thread), commentUrl(seed.posts.thread, seed.comments.third), postUrl(seed.posts.paged)]) {
    await gotoHydrated(page, path);
    // Links inside a comment's or the post's own text are words in a sentence (WCAG 2.5.8's inline exception).
    const small = await page.locator('main :is(button, a[href], textarea), a.post-vh').evaluateAll((nodes) =>
      nodes
        .filter((node) => node.checkVisibility() && !node.closest('.pb-comment__text, .post-text'))
        .map((node) => ({ name: node.getAttribute('aria-label') ?? node.textContent?.trim(), box: node.getBoundingClientRect() }))
        .filter(({ box }) => Math.min(box.width, box.height) < 44)
        .map(({ name, box }) => `${name}: ${Math.round(box.width)}×${Math.round(box.height)}`),
    );
    expect(small, path).toEqual([]);
  }
  await context.close();
});

test('without scripts the controls that need them are gone, and the reply form stays', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/auth/sign-in');
  await signIn(page, `@${seed.replier.name}`, seed.password);
  await page.waitForURL('/');
  await page.goto(postUrl(seed.posts.thread));
  await expect(page.getByText(`First comment ${seed.suffix}`)).toBeVisible();
  await expect(fold(page, seed.comments.first)).toBeHidden();
  await expect(actions(page, seed.comments.first).getByRole('button', { name: 'Reply' })).toBeHidden();
  await expect(actions(page, seed.comments.first).getByRole('button', { name: 'More actions' })).toBeHidden();
  await expect(page.locator('.post-share')).toHaveCount(2);
  await expect(page.locator('.post-share').first()).toBeHidden();
  const form = page.getByRole('form', { name: 'Reply' });
  await expect(form).toHaveAttribute('method', 'post');
  await expect(form.getByRole('textbox', { name: 'Reply' })).toBeEditable();
  await expect(form.getByRole('button', { name: 'Reply', exact: true })).toBeVisible();
  await context.close();
});
