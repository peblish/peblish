import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// "New since your last visit" on the lane database: a later visit marks the comments that arrived since (not the
// reader's own, not a removed one) and counts them, the jump goes from one to the next and says where it is, a first
// visit is the baseline, and only a page on screen records a visit (a same-site POST to /post/<id>/visit): no HEAD,
// no plain GET (a link preview, a crawler, a prefetch), no cross-site post and no page without scripts. The control's states are in new-since-states.spec.ts.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  reader: { name: string; actorId: string };
  posts: { seen: string; unseen: string; untouched: string };
  comments: { old: string; first: string; own: string; second: string; removed: string; waiting: string };
};
type Marker = { lastVisitAt: string; previousVisitAt: string | null } | null;

const root = join(import.meta.dirname, '../..');
const run = (...args: string[]) =>
  execFileSync('node', ['packages/core/src/testing/seed-visits.ts', ...args], { cwd: root, encoding: 'utf8' });
let seed: Seed;
test.beforeAll(() => {
  seed = JSON.parse(run('e2e')) as Seed;
});
const marker = (postId: string) => JSON.parse(run('marker', seed.reader.actorId, postId)) as Marker;

const row = (page: Page, id: string) => page.locator(`#comment-${id}`);
const mark = (page: Page, id: string) => row(page, id).locator('> .pb-comment__head .pb-comment__new');
const jump = (page: Page) => page.locator('.th-new');

async function signedIn(page: Page) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${seed.reader.name}`, seed.password);
  await landed(page, '/');
}

test('a later visit marks and counts what arrived since, not the reader’s own or a removed comment', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, `/post/${seed.posts.seen}`);
  await expect(page.getByRole('link', { name: '2 new since your last visit' })).toBeVisible();
  for (const id of [seed.comments.first, seed.comments.second]) {
    await expect(mark(page, id)).toHaveText('New');
    await expect(row(page, id)).toHaveAttribute('data-new', 'true');
  }
  for (const id of [seed.comments.old, seed.comments.own, seed.comments.removed]) {
    await expect(mark(page, id)).toHaveCount(0);
    await expect(row(page, id)).not.toHaveAttribute('data-new');
  }
  // The page on screen recorded the visit: the earlier one became the boundary.
  await expect.poll(() => marker(seed.posts.seen)?.previousVisitAt ?? null).not.toBeNull();
  // A reload, or another sort, is the same visit: the same comments are new.
  await page.reload();
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await expect(jump(page)).toHaveText('2 new since your last visit');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page).toHaveURL(/sort=new/);
  await expect(mark(page, seed.comments.first)).toHaveText('New');
  await expect(mark(page, seed.comments.second)).toHaveText('New');
});

test('the jump moves focus to each new comment in turn, round again, and says which', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, `/post/${seed.posts.seen}`);
  const order = await page.locator('.pb-comment[data-new]').evaluateAll((rows) => rows.map((row) => row.id));
  expect(order.toSorted()).toEqual([`comment-${seed.comments.first}`, `comment-${seed.comments.second}`].toSorted());
  const status = page.locator('.th-head [role="status"]');
  for (const [index, id] of [...order, order[0]!].entries()) {
    await jump(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`#${id}`)).toBeFocused();
    await expect(status).toHaveText(`New comment ${(index % order.length) + 1} of ${order.length}`);
  }
  // Straight there: the comment is in view at once.
  await expect(page.locator(`#${order[0]}`)).toBeInViewport();
});

test('a first visit is the baseline: nothing is new, then or on a reload', async ({ page }) => {
  await signedIn(page);
  expect(marker(seed.posts.unseen)).toBeNull();
  await gotoHydrated(page, `/post/${seed.posts.unseen}`);
  await expect(row(page, seed.comments.waiting)).toBeVisible();
  await expect(jump(page)).toHaveCount(0);
  await expect(mark(page, seed.comments.waiting)).toHaveCount(0);
  await expect.poll(() => marker(seed.posts.unseen)).toMatchObject({ previousVisitAt: null });
  await page.reload();
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await expect(row(page, seed.comments.waiting)).toBeVisible();
  await expect(jump(page)).toHaveCount(0);
});

async function signedInWithoutScripts(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/auth/sign-in');
  await signIn(page, `@${seed.reader.name}`, seed.password);
  await page.waitForURL('/');
  return { context, page };
}

test('a HEAD, a plain GET, a cross-site post and a page without scripts record nothing, and the jump is a link there', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await signedInWithoutScripts(browser, baseURL!);
  const thread = `/post/${seed.posts.untouched}`;
  // The session's cookie goes with each: what a link preview, a crawler or a prefetch would send.
  expect((await page.request.head(thread)).ok()).toBe(true);
  expect((await page.request.get(thread)).ok()).toBe(true);
  // The endpoint itself records only a same-site POST.
  expect((await page.request.get(`${thread}/visit`, { maxRedirects: 0 })).status()).toBe(307);
  expect((await page.request.post(`${thread}/visit`, { headers: { origin: 'https://elsewhere.example' } })).status()).toBe(403);
  await page.goto(thread);
  await expect(page.locator('#comments')).toBeVisible();
  expect(marker(seed.posts.untouched)).toBeNull();

  // The visited thread still marks its new comments, and the jump is a link to the first one.
  await page.goto(`/post/${seed.posts.seen}`);
  const first = await page.locator('.pb-comment[data-new]').first().getAttribute('id');
  await expect(page.getByRole('link', { name: '2 new since your last visit' })).toHaveAttribute('href', `#${first}`);
  await context.close();
  expect(marker(seed.posts.untouched)).toBeNull();
});

test('on a phone the jump is a 44px target', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await signedIn(page);
  await gotoHydrated(page, `/post/${seed.posts.seen}`);
  const box = await jump(page).boundingBox();
  expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
  await context.close();
});
