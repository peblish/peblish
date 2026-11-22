import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The feed's place is in its address: the list writes how many rows it holds into its own history entry
// (`n`), and any load of that entry reads them again, fresh, in one answer from the server. These run on
// a reader whose Subscribed feed is one community of 220 posts, two years old, so they are also the
// oldest in All (packages/core/src/testing/seed-depth.ts). They wait on the requests they hold and on
// what is on screen. The steps share the seed and change posts, so they run in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

const script = 'packages/core/src/testing/seed-depth.ts';
const run = (...args: string[]) => execFileSync('node', [script, ...args], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });

let seed: { password: string; name: string; suffix: string };
test.beforeAll(() => {
  seed = JSON.parse(run()) as typeof seed;
});

/** The seed's post `n`, 1 the newest. */
const title = (n: number) => `Depth ${seed.suffix} ${String(n).padStart(3, '0')}`;
const rows = (page: Page) => page.locator('.feed-list > li');
const link = (page: Page, name: string) => page.locator('.feed-list .pb-post__title a', { hasText: new RegExp(`^${name}$`) });

async function signedIn(page: Page) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${seed.name}`, seed.password);
  await landed(page, '/');
}

/** A read of a feed: the route's loader, or a batch after a cursor. */
const isFeedRead = (url: URL) => url.pathname.includes('/_serverFn/') && /"feed","sort","period"/.test(decodeURIComponent(url.search));
const asks = (request: Request, text: string) => decodeURIComponent(request.url()).includes(text);

/** Every read of a feed from here on waits until the test lets it go; one the page gives up meanwhile fails. */
async function holdReads(page: Page) {
  const held: { request: Request; go: () => void }[] = [];
  await page.route(isFeedRead, async (route) => {
    let go!: () => void;
    const gate = new Promise<void>((resolve) => (go = resolve));
    held.push({ request: route.request(), go });
    await gate;
    await route.fallback().catch(() => undefined);
  });
  return held;
}

/** Scrolls to the end of the list until it holds `count` rows. */
async function loadTo(page: Page, count: number) {
  await expect(async () => {
    await rows(page).last().scrollIntoViewIfNeeded();
    expect(await rows(page).count()).toBeGreaterThanOrEqual(count);
  }).toPass({ timeout: 30_000 });
}

/** How many rows the list holds once no batch is on its way and its address says so (reaching a row can load one more batch). */
async function holding(page: Page) {
  await expect(page.locator('.pb-feed-end[data-state="pending"]')).toHaveCount(0);
  const count = await rows(page).count();
  await expect(page).toHaveURL(new RegExp(`n=${count}$`));
  return count;
}

/** Two frames, so the scroll event of a scroll just made has reached the router (it keeps the position for Back). */
const settled = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** Opens the Sort menu and picks a sort (Mux names the menu by its trigger, "Sort: Hot"). */
async function sortBy(page: Page, sort: 'New' | 'Old') {
  await page.getByRole('button', { name: /^Sort: / }).click();
  await page.getByRole('menuitem', { name: sort, exact: true }).click();
}

test('signed out, with batch two still loading when the reader opens a slow post, Back draws no row before the fresh answer, and a post removed meanwhile never appears', async ({
  page,
}) => {
  await gotoHydrated(page, '/all?sort=old');
  await expect(rows(page).first()).toContainText(title(220));
  const held = await holdReads(page);
  // Batch two (rows 21 to 40) is asked for, and waits.
  await rows(page).last().scrollIntoViewIfNeeded();
  await expect.poll(() => held.length).toBe(1);
  expect(asks(held[0]!.request, '"cursor"')).toBe(true);
  // The reader opens a post whose page is slow.
  let post!: () => void;
  const slow = new Promise<void>((resolve) => (post = resolve));
  await page.route(
    (url) => url.pathname.includes('/_serverFn/') && !isFeedRead(url),
    async (route) => {
      await slow;
      await route.fallback();
    },
  );
  await link(page, title(218)).click();
  await page.waitForURL(/\/post\//);
  // Meanwhile a moderator removes a post of batch two, and batch two's answer from before comes.
  run('remove', title(196));
  try {
    post();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(218));
    held[0]!.go();
    await page.goBack();
    await expect.poll(() => held.length).toBe(2);
    expect(asks(held[1]!.request, '"cursor"')).toBe(false);
    // Until the loader's fresh answer is in, no row of the feed is drawn: the feed's loading page shows.
    await expect(page.locator('#pb-main main[aria-busy="true"]').getByRole('status')).toHaveText('Loading posts');
    await expect(rows(page)).toHaveCount(0);
    held[1]!.go();
    await expect(rows(page)).toHaveCount(20);
    // Batch two was never in the list, so it loads as usual, and fresh.
    await rows(page).last().scrollIntoViewIfNeeded();
    await expect.poll(() => held.length).toBe(3);
    held[2]!.go();
    await expect(rows(page)).toHaveCount(40);
    await expect(link(page, title(196))).toHaveCount(0);
    await expect(link(page, title(195))).toHaveCount(1);
  } finally {
    run('restore', title(196));
  }
});

test('from 80 New rows, Back to a slow Old sort, then Forward: 80 rows, and the link the reader left from is on screen', async ({
  page,
}) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=old');
  await sortBy(page, 'New');
  await page.waitForURL('**/?sort=new');
  await loadTo(page, 80);
  await link(page, title(61)).scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  const held = await holdReads(page);
  await page.goBack();
  await expect.poll(() => held.length).toBe(1);
  expect(asks(held[0]!.request, '"old"')).toBe(true);
  // Old is slow: the reader goes Forward before it answers.
  await page.goForward();
  await expect.poll(() => held.length).toBe(2);
  expect(asks(held[1]!.request, '"new"')).toBe(true);
  held[1]!.go();
  await expect(rows(page)).toHaveCount(count);
  await expect(link(page, title(61))).toBeInViewport();
});

test('two posts that swapped between batches while the reader was away are both shown once', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await loadTo(page, 60);
  await link(page, title(50)).scrollIntoViewIfNeeded();
  const count = await holding(page);
  await link(page, title(50)).click();
  await page.waitForURL(/\/post\//);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(50));
  // Post 25 (batch two) and post 45 (batch three) trade places.
  run('swap', title(25), title(45));
  try {
    await page.goBack();
    await expect(rows(page)).toHaveCount(count);
    await expect(link(page, title(25))).toHaveCount(1);
    await expect(link(page, title(45))).toHaveCount(1);
    await expect(rows(page).nth(24)).toContainText(title(45));
    await expect(rows(page).nth(44)).toContainText(title(25));
  } finally {
    run('swap', title(25), title(45));
  }
});

/** Requests that cast a vote on the post `id` (castVoteFn is a POST to a server function). */
const isVoteOn = (id: string) => (request: Request) =>
  request.method() === 'POST' && request.url().includes('/_serverFn/') && (request.postData() ?? '').includes(id);

test("an upvote acknowledged while the loader's reload is on its way survives that reload's older answer", async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  const card = rows(page).first();
  const id = (await card.locator('.pb-post__title a').getAttribute('href'))!.split('/').pop()!;
  const score = Number(await card.locator('.pb-vote__score').textContent());
  // The vote's request waits, and the reader opens the post while it does.
  let vote!: () => void;
  const voting = new Promise<void>((resolve) => (vote = resolve));
  await page.route(
    (url) => url.pathname.includes('/_serverFn/'),
    async (route) => {
      if (isVoteOn(id)(route.request())) await voting;
      await route.fallback();
    },
  );
  await card.getByRole('button', { name: 'Upvote' }).click();
  await card.locator('.pb-post__title a').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(1));
  // Back: the server answers the loader before the vote reaches it; the answer is held.
  let fetched!: () => void;
  const answered = new Promise<void>((resolve) => (fetched = resolve));
  let deliver!: () => void;
  const delivered = new Promise<void>((resolve) => (deliver = resolve));
  await page.route(isFeedRead, async (route) => {
    const response = await route.fetch();
    fetched();
    await delivered;
    await route.fulfill({ response });
  });
  await page.goBack();
  await answered;
  const acknowledged = page.waitForResponse((response) => isVoteOn(id)(response.request()));
  vote();
  await acknowledged;
  deliver();
  const shown = rows(page).first();
  await expect(shown).toContainText(title(1));
  await expect(shown.getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'true');
  await expect(shown.locator('.pb-vote__score')).toHaveText(String(score + 1));
  // Taken back, so the next run starts from the same score.
  const back = page.waitForResponse((response) => isVoteOn(id)(response.request()));
  await shown.getByRole('button', { name: 'Upvote' }).click();
  await back;
});

test("a take-back that answers no tally (the post is withheld from the reader now) moves only the reader's vote out of the score", async ({
  page,
}) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  const card = rows(page).nth(1);
  const id = (await card.locator('.pb-post__title a').getAttribute('href'))!.split('/').pop()!;
  const answered = () => page.waitForResponse((response) => isVoteOn(id)(response.request()));
  // The vote group is busy until the row has taken the server's answer.
  const group = card.locator('.pb-vote');
  const score = card.locator('.pb-vote__score');
  const up = card.getByRole('button', { name: 'Upvote' });
  const before = Number(await score.textContent());
  const saved = answered();
  await up.click();
  await saved;
  await expect(group).not.toHaveAttribute('aria-busy');
  await expect(up).toHaveAttribute('aria-pressed', 'true');
  await expect(score).toHaveText(String(before + 1));
  // The post is marked sensitive; this reader has not declared 16+, so the take-back is answered with no tally.
  run('sensitive', title(2), 'true');
  try {
    const takenBack = answered();
    await up.click();
    await takenBack;
    await expect(group).not.toHaveAttribute('aria-busy');
    await expect(up).toHaveAttribute('aria-pressed', 'false');
    await expect(score).toHaveText(String(before));
  } finally {
    run('sensitive', title(2), 'false');
  }
});

test('Back, Forward, Back leaves no request running for an entry the reader has left', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await loadTo(page, 40);
  await link(page, title(30)).scrollIntoViewIfNeeded();
  const count = await holding(page);
  await link(page, title(30)).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(30));
  const held = await holdReads(page);
  await page.goBack();
  await expect.poll(() => held.length).toBe(1);
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(30));
  // The router's abort signal reached the loader's request: the browser gave it up.
  await expect.poll(() => held[0]!.request.failure()?.errorText ?? null).not.toBeNull();
  await page.goBack();
  await expect.poll(() => held.length).toBe(2);
  held[1]!.go();
  await expect(rows(page)).toHaveCount(count);
  expect(held).toHaveLength(2);
});

test('an address deeper than 200 rows comes back with 200, and the list loads on below them', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new&n=280');
  await expect(page).toHaveURL(/\/\?sort=new&n=200$/);
  await expect(rows(page)).toHaveCount(200);
  await expect(rows(page).last()).toContainText(title(200));
  await loadTo(page, 220);
  await expect(page.locator('.pb-feed-end')).toHaveText('That is everything for now.');
});

test('an address with no whole number of batches is one batch', async ({ page }) => {
  await signedIn(page);
  for (const n of ['7', 'abc', '-20']) {
    await gotoHydrated(page, `/?sort=new&n=${n}`);
    await expect(page).toHaveURL(/\/\?sort=new$/);
    await expect(rows(page)).toHaveCount(20);
  }
});

test('a reload at depth comes back to the same rows and place', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await loadTo(page, 80);
  await link(page, title(61)).scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  await page.reload();
  await expect(rows(page)).toHaveCount(count);
  await expect(link(page, title(61))).toBeInViewport();
});

test('while a post it opened loads, the list keeps its rows and place, and a quick Back finds them', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await loadTo(page, 40);
  await link(page, title(30)).scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  const y = await page.evaluate(() => Math.round(scrollY));
  let post!: () => void;
  const slow = new Promise<void>((resolve) => (post = resolve));
  await page.route(
    (url) => url.pathname.includes('/_serverFn/') && !isFeedRead(url),
    async (route) => {
      await slow;
      await route.fallback().catch(() => undefined);
    },
  );
  await link(page, title(30)).click();
  await page.waitForURL(/\/post\//);
  await expect(rows(page)).toHaveCount(count);
  expect(await page.evaluate(() => Math.round(scrollY))).toBe(y);
  // Back before the post has drawn.
  await page.goBack();
  post();
  await page.waitForURL(`**/?sort=new&n=${count}`);
  await expect(rows(page)).toHaveCount(count);
  await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBe(y);
});

test('with reduced motion, Back puts the place back in one step', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await loadTo(page, 60);
  await link(page, title(41)).scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  const y = await page.evaluate(() => Math.round(scrollY));
  await link(page, title(41)).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(41));
  // Every position the window takes from here on.
  await page.evaluate(() => {
    const at: number[] = [];
    Object.assign(window, { at });
    addEventListener('scroll', () => at.push(Math.round(scrollY)));
  });
  await page.goBack();
  await expect(rows(page)).toHaveCount(count);
  await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBe(y);
  // No position between the post page's top and the reader's place: nothing animated the way there.
  const at = await page.evaluate(() => (window as unknown as { at: number[] }).at);
  expect(at.filter((value) => value !== 0 && value !== y)).toEqual([]);
});

test('an ordinary visit to a feed reads one batch, once, and draws it', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, `/?sort=new`);
  await link(page, title(1)).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(1));
  const reads: Request[] = [];
  page.on('request', (request) => isFeedRead(new URL(request.url())) && reads.push(request));
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: 'All', exact: true }).click();
  await page.waitForURL('**/all');
  await expect(rows(page)).toHaveCount(20);
  expect(reads).toHaveLength(1);
  expect(asks(reads[0]!, '"n"')).toBe(false);
});

test('a link back to a feed the router still holds draws none of its rows before the fresh answer', async ({ page }) => {
  const sidebar = (name: string) => page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name, exact: true });
  await gotoHydrated(page, '/all');
  await expect(page.locator('main.feed[data-feed="all"]')).toHaveCount(1);
  await sidebar('Local').click();
  await expect(page.locator('main.feed[data-feed="local"]')).toHaveCount(1);
  const held = await holdReads(page);
  await sidebar('All').click();
  await expect.poll(() => held.length).toBe(1);
  // The page the reader was on, then the feed's loading page: never the rows All had when the reader left it.
  await expect(page.locator('#pb-main main[aria-busy="true"]').getByRole('status')).toHaveText('Loading posts');
  await expect(page.locator('main.feed[data-feed="all"]')).toHaveCount(0);
  held[0]!.go();
  await expect(page.locator('main.feed[data-feed="all"] .feed-list > li')).toHaveCount(20);
});

test("a press on the frame's link to the feed shown, at depth, puts the list at its top without reading it again", async ({ page }) => {
  await gotoHydrated(page, '/all');
  await loadTo(page, 40);
  await rows(page).nth(30).scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  const reads: Request[] = [];
  page.on('request', (request) => isFeedRead(new URL(request.url())) && reads.push(request));
  // The sidebar's link has no `n`: the address's depth is how far the list has loaded, not another page.
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: 'All', exact: true }).click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(rows(page).first().locator('.pb-post__title a')).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/all\\?n=${count}$`));
  await expect(rows(page)).toHaveCount(count);
  expect(reads).toHaveLength(0);
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('an address with n=60 is drawn with 60 rows by the server, and the next page is a plain link', async ({ page }) => {
    await page.goto('/all?sort=old&n=60');
    await expect(rows(page)).toHaveCount(60);
    await expect(rows(page).first()).toContainText(title(220));
    const next = page.getByRole('link', { name: 'Next page' });
    await expect(next).toHaveAttribute('href', /^\/all\?sort=old&cursor=[^&]+$/);
    // It goes on from the last of the 60.
    await next.click();
    await expect(rows(page).first()).toContainText(title(160));
  });
});
