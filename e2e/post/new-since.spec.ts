import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Browser, type Page, type Request } from '@playwright/test';
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
const execFileAsync = promisify(execFile);
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

/** A tab that starts in the background: hidden until `show(tab)` brings it forward (`hide(tab)` sends it back). */
async function backgroundTab(page: Page) {
  const tab = await page.context().newPage();
  await tab.addInitScript(() => {
    let state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
    const set = (next: DocumentVisibilityState) => {
      state = next;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    Object.assign(window, { __show: () => set('visible'), __hide: () => set('hidden') });
  });
  return tab;
}
const show = (tab: Page) => tab.evaluate(() => (window as unknown as { __show: () => void }).__show());
const hide = (tab: Page) => tab.evaluate(() => (window as unknown as { __hide: () => void }).__hide());

/** A reload of the post's data for this tab: a server function asked about this post (the route's loader, or the thread's). */
const isReload = (request: Request, postId: string) =>
  request.method() === 'GET' && request.url().includes('/_serverFn/') && decodeURIComponent(request.url()).includes(postId);
const isVisit = (request: Request, postId: string) => request.method() === 'POST' && request.url().endsWith(`/post/${postId}/visit`);

/** What the tab asked and was answered, in order: each reload of the post answered or failed, and each visit sent. */
function journal(tab: Page, postId: string) {
  const events: string[] = [];
  tab.on('requestfinished', (request) => isReload(request, postId) && events.push('reload answered'));
  tab.on('requestfailed', (request) => isReload(request, postId) && events.push('reload failed'));
  tab.on('request', (request) => isVisit(request, postId) && events.push('visit'));
  return events;
}

/** What the page held at the moment a visit went out: the comments drawn and the thread's heading. */
type Seen = { rows: string[]; heading: string };
/**
 * Sends each visit of `postId` on after noting what the page held as it started (in the handler that
 * intercepts it, so a page drawn only after the request went cannot pass). `first` settles on the first.
 */
async function watchVisits(tab: Page, postId: string) {
  const seen: Seen[] = [];
  let went!: () => void;
  const first = new Promise<void>((done) => (went = done));
  await tab.route(`**/post/${postId}/visit`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    seen.push(
      await tab.evaluate(() => ({
        rows: [...document.querySelectorAll('#comments .pb-comment')].map((found) => found.id.replace(/^comment-/, '')),
        heading: document.querySelector('#comments-heading')?.textContent ?? '',
      })),
    );
    went();
    await route.fallback();
  });
  return { seen, first };
}

/**
 * Holds the answer to the first reload of `postId` the tab asks for: the server answers at once (so the
 * answer is a snapshot of that moment), and the tab gets it only on `release()`.
 */
async function holdFirstReload(tab: Page, postId: string) {
  let asked!: () => void;
  const held = new Promise<void>((done) => (asked = done));
  let release!: () => void;
  const released = new Promise<void>((done) => (release = done));
  let taken = false;
  await tab.route('**/_serverFn/**', async (route) => {
    if (taken || !isReload(route.request(), postId)) return route.fallback();
    taken = true;
    const response = await route.fetch();
    asked();
    await released;
    // The tab may have given up on it meanwhile (a newer reload supersedes it).
    await route.fulfill({ response }).catch(() => undefined);
  });
  return { held, release };
}

/** Makes the post sensitive: an undeclared reader then gets the gate in its place. */
const makeSensitive = (postId: string) =>
  execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { eq } from 'drizzle-orm';
import { closePools } from './src/db/pools.ts';
import { posts } from './src/db/tables/content.ts';
import { writer } from './src/db/write.ts';
await writer().update(posts).set({ sensitive: true }).where(eq(posts.id, process.argv[1]));
await closePools();`,
      postId,
    ],
    { cwd: join(root, 'packages/core'), encoding: 'utf8' },
  );

/** The name of the seed's other author (who wrote `first`), from the page. */
const authorOf = async (tab: Page, id: string) =>
  (await row(tab, id).locator('> .pb-comment__head .pb-comment__author').textContent())!.trim().replace(/^@/, '').split('@')[0]!;

/** `name` comments on `postId` through the real action; the new comment's id. */
const say = (postId: string, name: string) =>
  (
    JSON.parse(
      execFileSync('node', ['packages/core/src/testing/seed-notify.ts', 'comment', postId, name], { cwd: root, encoding: 'utf8' }),
    ) as {
      id: string;
    }
  ).id;
/** `count` comments by `name` on `postId`, three at a time (each is a process with its own pool on the shared server). */
async function sayAll(postId: string, name: string, count: number) {
  for (let done = 0; done < count; done += 3)
    await Promise.all(
      Array.from({ length: Math.min(3, count - done) }, () =>
        execFileAsync('node', ['packages/core/src/testing/seed-notify.ts', 'comment', postId, name], { cwd: root, encoding: 'utf8' }),
      ),
    );
}
/** The parent the server stored for the comment whose text is `body` ('none' when there is no such comment). */
const storedParent = (body: string) =>
  JSON.parse(
    execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { eq } from 'drizzle-orm';
import { closePools } from './src/db/pools.ts';
import { db } from './src/db/read.ts';
import { comments } from './src/db/tables/content.ts';
const [found] = await db().select({ parentId: comments.parentId }).from(comments).where(eq(comments.bodyMd, process.argv[1]));
console.log(JSON.stringify(found ? found.parentId : 'none'));
await closePools();`,
        body,
      ],
      { cwd: join(root, 'packages/core'), encoding: 'utf8' },
    ),
  ) as string | null;

/** Lets a tab settle: the effects of its last render have run. */
const settled = (tab: Page) => tab.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done))));

test('a thread opened in the background is reloaded when brought forward, and its visit sent once it is drawn; only once; one never brought forward records nothing', async ({
  page,
}) => {
  // Its own cast: the cases above recorded visits on theirs. `seen` was last visited two hours ago.
  seed = JSON.parse(run('e2e')) as Seed;
  await signedIn(page);
  const before = marker(seed.posts.seen)!.lastVisitAt;

  const tab = await backgroundTab(page);
  const events = journal(tab, seed.posts.seen);
  const visits = await watchVisits(tab, seed.posts.seen);
  await gotoHydrated(tab, `/post/${seed.posts.seen}`);
  // A reply arrives while the tab is still in the background: nothing is sent meanwhile.
  const late = say(seed.posts.seen, await authorOf(tab, seed.comments.first));
  await settled(tab);
  expect(events).toEqual([]);
  expect(marker(seed.posts.seen)!.lastVisitAt).toBe(before);

  await show(tab);
  await visits.first;
  // The visit went once the reply that arrived was on the page, after the reload was answered.
  expect(visits.seen[0]!.rows).toContain(late);
  expect(events).toEqual(['reload answered', 'visit']);
  await expect(mark(tab, late)).toHaveText('New');
  await expect(jump(tab)).toHaveText('3 new since your last visit');
  await expect.poll(() => marker(seed.posts.seen)?.previousVisitAt ?? null).not.toBeNull();

  // Back and forth between tabs is the same visit: no second reload, no second record.
  await hide(tab);
  await show(tab);
  await settled(tab);
  expect(events).toEqual(['reload answered', 'visit']);

  // Another thread opened in the background and never brought forward writes nothing.
  const never = await backgroundTab(page);
  const nothing = journal(never, seed.posts.unseen);
  await gotoHydrated(never, `/post/${seed.posts.unseen}`);
  await settled(never);
  expect(nothing).toEqual([]);
  expect(marker(seed.posts.unseen)).toBeNull();
});

test('a tab brought forward before the page hydrated is reloaded too, before its visit', async ({ page }) => {
  seed = JSON.parse(run('e2e')) as Seed;
  await signedIn(page);
  const tab = await page.context().newPage();
  // In front by the time scripts run, but out of sight when it loaded: the document's visibility record says so.
  await tab.addInitScript(() => {
    const real = performance.getEntriesByType.bind(performance);
    performance.getEntriesByType = (type: string) =>
      type === 'visibility-state' ? ([{ name: 'hidden', entryType: 'visibility-state', startTime: 0, duration: 0 }] as never) : real(type);
  });
  const events = journal(tab, seed.posts.seen);
  const visits = await watchVisits(tab, seed.posts.seen);
  await gotoHydrated(tab, `/post/${seed.posts.seen}`);
  await visits.first;
  expect(events).toEqual(['reload answered', 'visit']);
  expect(visits.seen[0]!.rows).toContain(seed.comments.first);
});

test('a thread brought forward while its reload fails keeps what it showed, with no error page, and records nothing', async ({ page }) => {
  seed = JSON.parse(run('e2e')) as Seed;
  await signedIn(page);
  const before = marker(seed.posts.seen)!.lastVisitAt;
  const tab = await backgroundTab(page);
  const events = journal(tab, seed.posts.seen);
  await gotoHydrated(tab, `/post/${seed.posts.seen}`);
  await tab.context().setOffline(true);
  const failed = tab.waitForEvent('requestfailed');
  await show(tab);
  await failed;
  await settled(tab);
  await tab.context().setOffline(false);
  await expect(row(tab, seed.comments.first)).toBeVisible();
  await expect(jump(tab)).toHaveText('2 new since your last visit');
  expect(events.filter((event) => event === 'visit')).toEqual([]);
  expect(marker(seed.posts.seen)!.lastVisitAt).toBe(before);
});

test('a post put behind the gate while its tab was in the background shows the gate when brought forward, and records nothing', async ({
  page,
}) => {
  seed = JSON.parse(run('e2e')) as Seed;
  await signedIn(page);
  const before = marker(seed.posts.seen)!.lastVisitAt;
  const tab = await backgroundTab(page);
  const events = journal(tab, seed.posts.seen);
  await gotoHydrated(tab, `/post/${seed.posts.seen}`);
  await expect(row(tab, seed.comments.first)).toBeVisible();
  makeSensitive(seed.posts.seen);
  await show(tab);
  // What a fresh load of the page shows now: the gate, and nothing of the thread.
  await expect(tab.getByText('This post is NSFW')).toBeVisible();
  await expect(tab.locator('#comments')).toHaveCount(0);
  await settled(tab);
  expect(events.filter((event) => event === 'visit')).toEqual([]);
  expect(marker(seed.posts.seen)!.lastVisitAt).toBe(before);
});

test('the heading and the thread come from one reload: a comment that arrived adds one to both', async ({ page }) => {
  seed = JSON.parse(run('e2e')) as Seed;
  await signedIn(page);
  const tab = await backgroundTab(page);
  const visits = await watchVisits(tab, seed.posts.untouched);
  await gotoHydrated(tab, `/post/${seed.posts.untouched}`);
  const only = (await tab.locator('#comments .pb-comment').first().getAttribute('id'))!.replace(/^comment-/, '');
  // The post's stored count, as the heading says it (the seed writes its comment without counting it).
  const count = Number((await tab.locator('#comments-heading').textContent())!.match(/\d+/)![0]);
  const late = say(seed.posts.untouched, await authorOf(tab, only));
  await show(tab);
  await visits.first;
  const heading = count + 1 === 1 ? '1 comment' : `${count + 1} comments`;
  expect(visits.seen[0]!.rows).toEqual(expect.arrayContaining([only, late]));
  expect(visits.seen[0]!.heading).toBe(heading);
  await expect(tab.locator('#comments-heading')).toHaveText(heading);
});

for (const sort of ['old', 'hot'] as const)
  test(`under ${sort}, a reload answer held past the reader’s own reply draws nothing over it, and the visit still goes once`, async ({
    page,
  }) => {
    seed = JSON.parse(run('e2e')) as Seed;
    await signedIn(page);
    const tab = await backgroundTab(page);
    const events = journal(tab, seed.posts.seen);
    const visits = await watchVisits(tab, seed.posts.seen);
    await gotoHydrated(tab, `/post/${seed.posts.seen}?sort=${sort}`);
    const hold = await holdFirstReload(tab, seed.posts.seen);
    await show(tab);
    await hold.held;
    // The reader replies to the post while that answer (a snapshot without the reply) is held.
    const body = `Own reply ${sort} ${Math.random().toString(36).slice(2, 8)}`;
    const dock = tab.getByRole('form', { name: 'Reply' });
    await dock.getByRole('textbox', { name: 'Reply' }).fill(body);
    await dock.getByRole('button', { name: 'Reply' }).click();
    const own = tab.locator('#comments .pb-comment', { hasText: body });
    await expect(own).toBeVisible();
    hold.release();
    await visits.first;
    await settled(tab);
    await expect(own).toBeVisible();
    expect(events.filter((event) => event === 'visit')).toEqual(['visit']);
    const ownId = (await own.getAttribute('id'))!.replace(/^comment-/, '');
    expect(visits.seen[0]!.rows).toContain(ownId);
  });

test('a tab hidden while its reload is out, then shown again, records one visit, against what it then shows', async ({ page }) => {
  seed = JSON.parse(run('e2e')) as Seed;
  await signedIn(page);
  const tab = await backgroundTab(page);
  const events = journal(tab, seed.posts.seen);
  const visits = await watchVisits(tab, seed.posts.seen);
  await gotoHydrated(tab, `/post/${seed.posts.seen}`);
  const author = await authorOf(tab, seed.comments.first);
  const hold = await holdFirstReload(tab, seed.posts.seen);
  await show(tab);
  await hold.held;
  // Hidden before that answer came; a comment arrives; brought forward again; only then does the first answer come.
  await hide(tab);
  const late = say(seed.posts.seen, author);
  await show(tab);
  hold.release();
  await visits.first;
  await settled(tab);
  expect(events.filter((event) => event === 'visit')).toEqual(['visit']);
  expect(visits.seen).toHaveLength(1);
  expect(visits.seen[0]!.rows).toContain(late);
});

test('a later page brought forward is reloaded as that page, and a reply begun on it while that is slow keeps its parent', async ({
  page,
}) => {
  test.setTimeout(90_000);
  seed = JSON.parse(run('e2e')) as Seed;
  // Five top-level comments and 21 more: two pages of 25, oldest first.
  await sayAll(seed.posts.seen, seed.reader.name, 21);
  await signedIn(page);
  await gotoHydrated(page, `/post/${seed.posts.seen}?sort=old`);
  const later = await page.locator('#comments a[href*="after="]').first().getAttribute('href');
  expect(later).toBeTruthy();

  const tab = await backgroundTab(page);
  const visits = await watchVisits(tab, seed.posts.seen);
  await gotoHydrated(tab, later!);
  await expect(row(tab, seed.comments.old)).toHaveCount(0);
  const parent = (await tab.locator('#comments .pb-comment').first().getAttribute('id'))!.replace(/^comment-/, '');
  // The page's top-level comments: what must stay on screen, page two's and no others.
  const topLevel = () => tab.locator('#comments .pb-comment[data-level="0"]').evaluateAll((rows) => rows.map((found) => found.id));
  const pageTwo = await topLevel();
  const hold = await holdFirstReload(tab, seed.posts.seen);
  await row(tab, parent).locator('> .pb-comment__main .pb-comment__reply').click();
  const dock = tab.getByRole('form', { name: 'Reply' });
  const body = `From page two ${Math.random().toString(36).slice(2, 8)}`;
  await dock.getByRole('textbox', { name: 'Reply' }).fill(body);

  await show(tab);
  await hold.held;
  // While the reload is out, the page on screen stays page two: page one never stands in for it.
  expect(decodeURIComponent(tab.url())).toContain('after=');
  await expect(row(tab, parent)).toBeVisible();
  await expect.poll(topLevel).toEqual(pageTwo);
  const posted = tab.waitForResponse(
    (response) => response.url().endsWith(`/post/${seed.posts.seen}/comments`) && response.request().method() === 'POST',
  );
  await dock.getByRole('button', { name: 'Reply' }).click();
  expect((await posted).ok()).toBe(true);
  // The server stored the reply under the comment it answered, not as a top-level comment.
  expect(storedParent(body)).toBe(parent);

  hold.release();
  await visits.first;
  await settled(tab);
  // The visit went with page two on screen, and page two is still what the reader sees.
  expect(visits.seen).toHaveLength(1);
  expect(visits.seen[0]!.rows).toContain(parent);
  expect(visits.seen[0]!.rows).not.toContain(seed.comments.old);
  await expect(row(tab, parent)).toBeVisible();
  expect(await topLevel()).toEqual(pageTwo);
});

test('a reply keeps the comment it was begun on when that comment leaves the list (another sort)', async ({ page }) => {
  seed = JSON.parse(run('e2e')) as Seed;
  await sayAll(seed.posts.seen, seed.reader.name, 21);
  await signedIn(page);
  await gotoHydrated(page, `/post/${seed.posts.seen}?sort=old`);
  await row(page, seed.comments.old).locator('> .pb-comment__main .pb-comment__reply').click();
  const dock = page.getByRole('form', { name: 'Reply' });
  const body = `Across sorts ${Math.random().toString(36).slice(2, 8)}`;
  await dock.getByRole('textbox', { name: 'Reply' }).fill(body);
  // Newest first, the oldest comment is on the second page.
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page).toHaveURL(/sort=new/);
  await expect(row(page, seed.comments.old)).toHaveCount(0);
  await expect(dock.getByRole('textbox', { name: 'Reply' })).toHaveValue(body);
  const posted = page.waitForResponse(
    (response) => response.url().endsWith(`/post/${seed.posts.seen}/comments`) && response.request().method() === 'POST',
  );
  await dock.getByRole('button', { name: 'Reply' }).click();
  expect((await posted).ok()).toBe(true);
  expect(storedParent(body)).toBe(seed.comments.old);
});

test('a reload when brought forward keeps the reader’s scroll, focus, folds and open draft', async ({ page }) => {
  seed = JSON.parse(run('e2e')) as Seed;
  await signedIn(page);
  const tab = await backgroundTab(page);
  await tab.setViewportSize({ width: 1280, height: 500 });
  const visits = await watchVisits(tab, seed.posts.seen);
  await gotoHydrated(tab, `/post/${seed.posts.seen}`);
  await row(tab, seed.comments.old).locator('> .pb-comment__head .pb-comment__fold').click();
  await row(tab, seed.comments.first).locator('> .pb-comment__main .pb-comment__reply').click();
  const field = tab.getByRole('form', { name: 'Reply' }).getByRole('textbox', { name: 'Reply' });
  await field.fill('A draft in waiting');
  await tab.evaluate(() => window.scrollTo(0, 200));
  const scrolled = await tab.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);
  const late = say(seed.posts.seen, await authorOf(tab, seed.comments.first));

  await show(tab);
  await visits.first;
  expect(visits.seen[0]!.rows).toContain(late);
  await expect(field).toHaveValue('A draft in waiting');
  await expect(field).toBeFocused();
  await expect(row(tab, seed.comments.old)).toHaveAttribute('data-folded', 'true');
  expect(await tab.evaluate(() => window.scrollY)).toBe(scrolled);
  // The jump still goes to the new comments, the one that arrived among them.
  await jump(tab).click();
  await expect(tab.locator('.pb-comment[data-new]:focus')).toHaveCount(1);
});
