import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The thread's docked reply on the lane database: a refused reply can be sent again, by Send and by
// Ctrl+Enter, while an empty one is still held back; and moving into the dock by keyboard keeps the
// reader where they are in the thread.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  suffix: string;
  replier: { name: string };
  posts: { thread: string };
  comments: { first: string; second: string; third: string };
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

async function signedIn(page: Page) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${seed.replier.name}`, seed.password);
  await landed(page, '/');
}

test('a refused reply can be sent again, by Send and by Ctrl+Enter; an empty one is still held back', async ({ page }) => {
  await signedIn(page);
  // Every reply this page sends is refused, so nothing is written and each attempt is counted.
  let sent = 0;
  await page.route(`**${postUrl(seed.posts.thread)}/comments`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent += 1;
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'rate.limited' }) });
  });
  await gotoHydrated(page, postUrl(seed.posts.thread));
  const dock = page.getByRole('form', { name: 'Reply' });
  const field = dock.getByRole('textbox', { name: 'Reply' });
  const send = dock.getByRole('button', { name: 'Reply' });
  const refusal = 'You are commenting too fast. Wait a few minutes and try again.';

  // Empty, nothing goes: the browser's own check says why, and a blank one is held back too.
  await send.click();
  await expect(dock.getByRole('alert')).toHaveText('Fill in this field.');
  await field.fill('   ');
  await send.click();
  expect(sent).toBe(0);

  await field.fill(`A reply ${seed.suffix}`);
  await send.click();
  await expect(dock.getByRole('alert')).toHaveText(refusal);
  await expect.poll(() => sent).toBe(1);
  // The refusal marks the field invalid; Send still goes, and so does the shortcut after an edit.
  await send.click();
  await expect.poll(() => sent).toBe(2);
  // While a reply is on its way the dock takes no typing and no second send: wait for the answer.
  await expect(dock).not.toHaveAttribute('aria-busy');
  await field.press('End');
  await field.press('!');
  await field.press('ControlOrMeta+Enter');
  await expect.poll(() => sent).toBe(3);
  await expect(field).toHaveValue(`A reply ${seed.suffix}!`);
  await expect(dock.getByRole('alert')).toHaveText(refusal);

  // An empty draft is still held back while the refusal shows.
  await field.fill('');
  await send.click();
  await field.press('ControlOrMeta+Enter');
  await page.waitForTimeout(200);
  expect(sent).toBe(3);
});

test('moving into the dock by keyboard keeps the reader’s place in the thread; Reply still puts the caret there', async ({
  browser,
  baseURL,
}) => {
  // A window shorter than the thread, so the dock is stuck to its bottom while the thread runs on below.
  const context = await browser.newContext({ viewport: { width: 1280, height: 560 }, baseURL });
  const page = await context.newPage();
  await signedIn(page);
  await gotoHydrated(page, postUrl(seed.posts.thread));
  const dock = page.getByRole('form', { name: 'Reply' });
  const field = dock.getByRole('textbox', { name: 'Reply' });
  const reply = page.locator(`#comment-${seed.comments.second} > .pb-comment__main > .pb-comment__actions`).getByRole('button', {
    name: 'Reply',
  });
  await reply.scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, 120));
  const y = await page.evaluate(() => scrollY);
  const end = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  expect(end - y, 'the thread runs on below the window').toBeGreaterThan(200);

  // Reply points the dock at the comment and puts the caret there, the page where it was.
  await reply.click();
  await expect(field).toBeFocused();
  await expect(dock).toContainText('Replying to');
  expect(await page.evaluate(() => scrollY)).toBe(y);
  // Out of the field to the dock's cancel and back, by keyboard: the page stays.
  await page.keyboard.press('Shift+Tab');
  await expect(dock.getByRole('button', { name: 'cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(field).toBeFocused();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => scrollY)).toBe(y);
  await context.close();
});

test('with an on-screen keyboard over the dock, a Tab into it keeps the scroll that brings it into view', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 560 }, baseURL });
  const page = await context.newPage();
  // A keyboard over the lower part of the window: the visual viewport is its top 300px, where the dock, stuck to
  // the window's bottom, is not. The scroll the browser makes for the focus is noted before the dock sees it.
  await page.addInitScript(() => {
    const keyboard = { offsetTop: 0, offsetLeft: 0, height: 300, width: 1280, scale: 1, pageTop: 0, pageLeft: 0 };
    Object.assign(keyboard, { addEventListener: () => undefined, removeEventListener: () => undefined });
    Object.defineProperty(window, 'visualViewport', { get: () => keyboard, configurable: true });
    window.addEventListener('focusin', () => Object.assign(window, { browserScrolled: window.scrollY }), { capture: true });
  });
  await signedIn(page);
  await gotoHydrated(page, postUrl(seed.posts.thread));
  const dock = page.getByRole('form', { name: 'Reply' });
  const field = dock.getByRole('textbox', { name: 'Reply' });
  const reply = page.locator(`#comment-${seed.comments.second} > .pb-comment__main > .pb-comment__actions`).getByRole('button', {
    name: 'Reply',
  });
  await reply.scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, 120));
  const y = await page.evaluate(() => scrollY);
  await reply.click();
  await expect(field).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(field).toBeFocused();
  await page.waitForTimeout(100);
  const { browserScrolled, now } = await page.evaluate(() => ({
    browserScrolled: (window as unknown as { browserScrolled: number }).browserScrolled,
    now: scrollY,
  }));
  expect(browserScrolled, 'the browser scrolled for the focus').not.toBe(y);
  // Put back where it was, the field would be under the keyboard: the browser's scroll stands.
  expect(now).toBe(browserScrolled);
  await context.close();
});
