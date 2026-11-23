import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
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
/** The rows on screen: a page the router has suspended keeps its rows in the document, hidden. */
const shownRows = (page: Page) => rows(page).filter({ visible: true });
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

/**
 * Scrolls to the last row counted, by its place in the list, until the list holds `count` rows, and no further once
 * it does (the end's batch would follow); then it holds exactly that many.
 */
async function loadTo(page: Page, count: number) {
  await expect(async () => {
    const now = await rows(page).count();
    if (now >= count) return;
    await rows(page)
      .nth(now - 1)
      .scrollIntoViewIfNeeded();
    expect(await rows(page).count()).toBeGreaterThanOrEqual(count);
  }).toPass({ timeout: 30_000 });
  await expect(rows(page)).toHaveCount(count);
}

/** How many rows the list holds once no batch is on its way and its address says so (reaching a row can load one more batch). */
async function holding(page: Page) {
  let count = 0;
  await expect
    .poll(async () => {
      if (await page.locator('.pb-feed-end[data-state="pending"]').count()) return false;
      count = await rows(page).count();
      return new URL(page.url()).searchParams.get('n') === String(count);
    })
    .toBe(true);
  return count;
}

/**
 * The address and the rows on screen agree, once no batch and no read of the list is on its way: as many rows as
 * the address's `n` says (one batch without it), fewer only at the end of the feed (its end line says so), and at
 * the cap of 200 the rows the reader has loaded on below them.
 */
async function agrees(page: Page) {
  await expect(page.locator('.pb-feed-end[data-state="pending"]')).toHaveCount(0);
  await expect(page.locator('#pb-main main[aria-busy="true"], .feed-posts > .pb-rows[aria-busy="true"]')).toHaveCount(0);
  await expect
    .poll(async () => {
      const n = Number(new URL(page.url()).searchParams.get('n') ?? 20);
      const count = await rows(page).count();
      if (n === 200 && count >= 200) return true;
      const end = (await page.locator('.pb-feed-end').count()) ? await page.locator('.pb-feed-end').textContent() : null;
      return count === n || (count < n && end === 'That is everything for now.');
    })
    .toBe(true);
}

/** Two frames, so the scroll event of a scroll just made has reached the router (it keeps the position for Back). */
const settled = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/**
 * From the next Back, Forward or click on, whether a feed row titled `name` is ever on screen: checked on every
 * frame and on every node added between frames. A row the router keeps hidden (a page it has suspended) does
 * not count. Returns the answer so far.
 */
async function watchFor(page: Page, name: string) {
  await page.evaluate((name) => {
    const state = { seen: false };
    Object.assign(window, { watched: state });
    const selector = '.feed-list .pb-post__title a';
    const holds = (node: Element | Document) =>
      [...(node instanceof Element && node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)].some(
        (element) => element.textContent === name && element.checkVisibility(),
      );
    const frame = () => {
      if (holds(document)) state.seen = true;
      requestAnimationFrame(frame);
    };
    const start = () => {
      new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && holds(node)) state.seen = true;
      }).observe(document.body, { childList: true, subtree: true });
      requestAnimationFrame(frame);
    };
    addEventListener('popstate', start, { once: true });
    addEventListener('click', start, { once: true, capture: true });
  }, name);
  return () => page.evaluate(() => (window as unknown as { watched: { seen: boolean } }).watched.seen);
}

/** Every server function but the feed's reads waits until the returned function lets them go (a slow post page). */
async function slowPages(page: Page) {
  let go!: () => void;
  const slow = new Promise<void>((resolve) => (go = resolve));
  await page.route(
    (url) => url.pathname.includes('/_serverFn/') && !isFeedRead(url),
    async (route) => {
      await slow;
      await route.fallback().catch(() => undefined);
    },
  );
  return go;
}

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
    const seen = await watchFor(page, title(196));
    await page.goBack();
    await expect.poll(() => held.length).toBe(2);
    expect(asks(held[1]!.request, '"cursor"')).toBe(false);
    // Until the loader's fresh answer is in, no row of the feed is drawn: the feed's loading page shows.
    await expect(page.locator('#pb-main main[aria-busy="true"]').getByRole('status')).toHaveText('Loading posts');
    await expect(shownRows(page)).toHaveCount(0);
    held[1]!.go();
    await expect(rows(page)).toHaveCount(20);
    await agrees(page);
    // Batch two was never in the list, so it loads as usual, and fresh.
    await rows(page).last().scrollIntoViewIfNeeded();
    await expect.poll(() => held.length).toBe(3);
    held[2]!.go();
    await expect(rows(page)).toHaveCount(40);
    await agrees(page);
    await expect(link(page, title(196))).toHaveCount(0);
    await expect(link(page, title(195))).toHaveCount(1);
    expect(await seen()).toBe(false);
  } finally {
    run('restore', title(196));
  }
});

/**
 * Batch two is asked for and waits; the reader opens a slow post, a moderator removes a row of the first page,
 * the reader comes Back, and only then does batch two's answer from before come. It draws nothing, writes no
 * depth and leaves the return's read alone: the feed comes back fresh, one batch deep.
 */
async function lateBatch(page: Page, feed: string, { opened, removed }: { opened: number; removed: number }) {
  await gotoHydrated(page, feed);
  const held = await holdReads(page);
  await rows(page).last().scrollIntoViewIfNeeded();
  await expect.poll(() => held.length).toBe(1);
  expect(asks(held[0]!.request, '"cursor"')).toBe(true);
  const post = await slowPages(page);
  await link(page, title(opened)).click();
  await page.waitForURL(/\/post\//);
  run('remove', title(removed));
  try {
    const seen = await watchFor(page, title(removed));
    await page.goBack();
    await page.waitForURL((url) => `${url.pathname}${url.search}` === feed);
    await expect.poll(() => held.length).toBe(2);
    expect(asks(held[1]!.request, '"cursor"')).toBe(false);
    // Batch two's answer from before comes while the return's read is out.
    held[0]!.go();
    await (await held[0]!.request.response())?.finished();
    await settled(page);
    held[1]!.go();
    post();
    await expect(shownRows(page)).toHaveCount(20);
    await agrees(page);
    expect(new URL(page.url()).search).toBe(new URL(feed, 'http://feed').search);
    await expect(link(page, title(removed))).toHaveCount(0);
    expect(await seen()).toBe(false);
  } finally {
    run('restore', title(removed));
  }
}

test('signed out, a batch that answers only after the reader has come Back draws nothing, writes no depth and leaves the fresh read alone', ({
  page,
}) => lateBatch(page, '/all?sort=old', { opened: 218, removed: 205 }));

test.describe('signed in, on a phone', () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });

  test('a batch that answers only after the reader has come Back draws nothing, writes no depth and leaves the fresh read alone', async ({
    page,
  }) => {
    await signedIn(page);
    await lateBatch(page, '/?sort=new', { opened: 3, removed: 10 });
  });
});

test('a load-more still out when the reader goes Back to another document draws nothing and writes no depth', async ({ page }) => {
  await page.goto('/about');
  await gotoHydrated(page, '/all?sort=old');
  const held = await holdReads(page);
  await rows(page).last().scrollIntoViewIfNeeded();
  await expect.poll(() => held.length).toBe(1);
  // The reader goes back up first, so the feed comes back at its top, where no batch loads by itself.
  await page.evaluate(() => scrollTo(0, 0));
  await settled(page);
  // Back to the other document, whose answer is slow: the feed's document still runs when batch two answers.
  let asked = false;
  let answer!: () => void;
  const slow = new Promise<void>((resolve) => (answer = resolve));
  await page.route(
    (url) => url.pathname === '/about',
    async (route) => {
      asked = true;
      await slow;
      await route.fallback().catch(() => undefined);
    },
  );
  const back = page.goBack();
  await expect.poll(() => asked).toBe(true);
  held[0]!.go();
  await (await held[0]!.request.response())?.finished();
  // The leaving document still runs, though the page can no longer be asked anything: time for the answer to
  // land there, if it would.
  await page.waitForTimeout(500);
  answer();
  await back;
  // Back went through (a write of the depth by the leaving page would have cancelled it), and Forward reads one batch.
  await expect(page).toHaveURL(/\/about$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/all\?sort=old$/);
  await expect(shownRows(page)).toHaveCount(20);
  await agrees(page);
});

test('a reader still at the end of the list when they go Back to another document starts no other batch on the way out', async ({
  page,
}) => {
  await page.goto('/about');
  await gotoHydrated(page, '/all?sort=old');
  const held = await holdReads(page);
  await rows(page).last().scrollIntoViewIfNeeded();
  await expect.poll(() => held.length).toBe(1);
  let asked = false;
  let answer!: () => void;
  const slow = new Promise<void>((resolve) => (answer = resolve));
  await page.route(
    (url) => url.pathname === '/about',
    async (route) => {
      asked = true;
      await slow;
      await route.fallback().catch(() => undefined);
    },
  );
  const back = page.goBack();
  await expect.poll(() => asked).toBe(true);
  // The leaving page gave batch two up; with the end still in view, it must not ask for it again.
  await page.waitForTimeout(500);
  expect(held).toHaveLength(1);
  answer();
  await back;
  await expect(page).toHaveURL(/\/about$/);
});

test('a batch out while the page goes into the back-forward cache draws nothing once it is shown again; a hidden tab loads on as usual', async ({
  page,
}) => {
  await gotoHydrated(page, '/all?sort=old');
  const held = await holdReads(page);
  await rows(page).last().scrollIntoViewIfNeeded();
  await expect.poll(() => held.length).toBe(1);
  // The events of a page put into the back-forward cache and shown from it again (the test browser never keeps
  // the feed there itself: it reports the page's browsing instance, and the feed is no-store); then batch two's
  // answer comes.
  await page.evaluate(() => {
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  held[0]!.go();
  await (await held[0]!.request.response())?.finished();
  await settled(page);
  await expect(shownRows(page)).toHaveCount(20);
  expect(new URL(page.url()).search).toBe('?sort=old');
  // Load-more goes on as usual from there.
  await page.evaluate(() => scrollTo(0, 0));
  await settled(page);
  await rows(page).last().scrollIntoViewIfNeeded();
  await expect.poll(() => held.length).toBe(2);
  held[1]!.go();
  await expect(rows(page)).toHaveCount(40);
  await agrees(page);
  // A tab hidden and shown again while a batch is out keeps it.
  await rows(page).last().scrollIntoViewIfNeeded();
  await expect.poll(() => held.length).toBe(3);
  await page.evaluate(() => {
    for (const state of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  held[2]!.go();
  await expect(rows(page)).toHaveCount(60);
  await agrees(page);
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
  await agrees(page);
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
    await agrees(page);
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
  await agrees(page);
  // Taken back, so the next run starts from the same score.
  const back = page.waitForResponse((response) => isVoteOn(id)(response.request()));
  await shown.getByRole('button', { name: 'Upvote' }).click();
  await back;
});

test('a vote cast on the post page and saved while Back is on its way shows on the feed', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  const row = rows(page).nth(2);
  await expect(row).toContainText(title(3));
  const score = Number(await row.locator('.pb-vote__score').textContent());
  await link(page, title(3)).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(3));
  const id = new URL(page.url()).pathname.split('/').pop()!;
  // The vote's request waits until the feed's read is on its way.
  let vote!: () => void;
  const voting = new Promise<void>((resolve) => (vote = resolve));
  await page.route(
    (url) => url.pathname.includes('/_serverFn/'),
    async (route) => {
      if (isVoteOn(id)(route.request())) await voting;
      await route.fallback();
    },
  );
  await page.getByRole('group', { name: 'Vote on this post' }).getByRole('button', { name: 'Upvote' }).click();
  // Back: the server answers the feed's read before the vote reaches it, and the answer is held.
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
  const saved = page.waitForResponse((response) => isVoteOn(id)(response.request()));
  vote();
  await saved;
  deliver();
  const shown = rows(page).nth(2);
  await expect(shown).toContainText(title(3));
  await expect(shown.getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'true');
  await expect(shown.locator('.pb-vote__score')).toHaveText(String(score + 1));
  await agrees(page);
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
  await agrees(page);
  expect(held).toHaveLength(2);
});

test('an address deeper than 200 rows comes back with 200, and the list loads on below them', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new&n=280');
  await expect(page).toHaveURL(/\/\?sort=new&n=200$/);
  await expect(rows(page)).toHaveCount(200);
  await agrees(page);
  await expect(rows(page).last()).toContainText(title(200));
  await loadTo(page, 220);
  await expect(page.locator('.pb-feed-end')).toHaveText('That is everything for now.');
  await agrees(page);
});

test('an address at the cap with fewer rows left than that shows them all, and the end of the feed', async ({ page }) => {
  await signedIn(page);
  // The third page's address, from the second page's plain Next page link: 180 posts are left after row 40.
  await gotoHydrated(page, '/?sort=new');
  // A page's links with a cursor are its own address and the next page's.
  const nextOf = async (href: string) => {
    const html = await page.evaluate((href) => fetch(href).then((response) => response.text()), href);
    return [...html.matchAll(/href="(\/\?sort=new&amp;cursor=[^"&]+)"/g)]
      .map((match) => match[1]!.replaceAll('&amp;', '&'))
      .find((link) => link !== href);
  };
  const third = await nextOf((await nextOf('/?sort=new'))!);
  await gotoHydrated(page, `${third!}&n=200`);
  await expect(rows(page)).toHaveCount(180);
  await expect(rows(page).first()).toContainText(title(41));
  await expect(page.locator('.pb-feed-end')).toHaveText('That is everything for now.');
  await agrees(page);
});

test('an address with no whole number of batches is one batch', async ({ page }) => {
  await signedIn(page);
  for (const n of ['7', 'abc', '-20']) {
    await gotoHydrated(page, `/?sort=new&n=${n}`);
    await expect(page).toHaveURL(/\/\?sort=new$/);
    await expect(rows(page)).toHaveCount(20);
    await agrees(page);
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
  await agrees(page);
});

/**
 * Back to the feed from a post it opened, with the feed's read held: before the post has drawn (its requests are
 * held, so it cannot draw) or after. A moderator has removed a post below the reader's place before they open
 * the post. No row is on screen until the fresh answer, the removed post never is, and the place comes back.
 */
async function backFromPost(page: Page, when: 'before it draws' | 'after it draws') {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await loadTo(page, 40);
  await link(page, title(30)).scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  const y = await page.evaluate(() => Math.round(scrollY));
  run('remove', title(38));
  try {
    const post = when === 'before it draws' ? await slowPages(page) : () => undefined;
    await link(page, title(30)).click();
    await page.waitForURL(/\/post\//);
    if (when === 'after it draws') await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(30));
    const seen = await watchFor(page, title(38));
    const held = await holdReads(page);
    await page.goBack();
    await expect.poll(() => held.length).toBe(1);
    expect(asks(held[0]!.request, '"cursor"')).toBe(false);
    await expect(shownRows(page)).toHaveCount(0);
    held[0]!.go();
    post();
    await page.waitForURL(`**/?sort=new&n=${count}`);
    await expect(shownRows(page)).toHaveCount(count);
    await agrees(page);
    await expect(link(page, title(38))).toHaveCount(0);
    expect(await seen()).toBe(false);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBe(y);
  } finally {
    run('restore', title(38));
  }
}

test('a quick Back, before the post it opened has drawn, shows no row until the fresh answer, nor a post removed meanwhile', ({ page }) =>
  backFromPost(page, 'before it draws'));

test('Back after the post has drawn shows no row until the fresh answer, nor a post removed meanwhile', ({ page }) =>
  backFromPost(page, 'after it draws'));

test('two quick Backs, through a page still loading, draw no row from before and come back to the place', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await loadTo(page, 60);
  await link(page, title(45)).scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  const y = await page.evaluate(() => Math.round(scrollY));
  await link(page, title(45)).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(45));
  // On to the post's community.
  await page.locator('#pb-main a[href^="/c/"]').first().click();
  await page.waitForURL(/\/c\//);
  await expect(page.locator('#pb-main main[aria-busy="true"]')).toHaveCount(0);
  run('remove', title(58));
  try {
    const post = await slowPages(page);
    const held = await holdReads(page);
    const seen = await watchFor(page, title(58));
    // Back to the post, still loading, and at once Back again, to the feed.
    await page.goBack();
    await page.goBack();
    await page.waitForURL(`**/?sort=new&n=${count}`);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    post();
    for (const read of held) read.go();
    await expect(rows(page)).toHaveCount(count);
    await agrees(page);
    await expect(link(page, title(58))).toHaveCount(0);
    expect(await seen()).toBe(false);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBe(y);
  } finally {
    run('restore', title(58));
  }
});

test("the sidebar's link to the feed shown, pressed while a post it opened loads, reads the feed again and draws none of its old rows", async ({
  page,
}) => {
  await signedIn(page);
  await gotoHydrated(page, '/');
  await loadTo(page, 40);
  await link(page, title(25)).scrollIntoViewIfNeeded();
  await settled(page);
  await holding(page);
  const post = await slowPages(page);
  await link(page, title(25)).click();
  await page.waitForURL(/\/post\//);
  run('remove', title(5));
  try {
    const seen = await watchFor(page, title(5));
    const held = await holdReads(page);
    await page.getByRole('complementary', { name: 'Sidebar' }).locator('a[href="/"]').first().click();
    await page.waitForURL((url) => url.pathname === '/' && url.search === '');
    await expect.poll(() => held.length).toBe(1);
    await expect(shownRows(page)).toHaveCount(0);
    post();
    held[0]!.go();
    // The first page, fresh, and an address that says so.
    await expect(rows(page)).toHaveCount(20);
    await agrees(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(link(page, title(5))).toHaveCount(0);
    expect(await seen()).toBe(false);
  } finally {
    run('restore', title(5));
  }
});

test('choosing the sort already chosen, at depth, changes nothing; another sort starts again at one batch', async ({ page }) => {
  await gotoHydrated(page, '/all?sort=old&n=100');
  await expect(rows(page)).toHaveCount(100);
  await agrees(page);
  const reads: Request[] = [];
  page.on('request', (request) => isFeedRead(new URL(request.url())) && reads.push(request));
  await sortBy(page, 'Old');
  await settled(page);
  await expect(page).toHaveURL(/\/all\?sort=old&n=100$/);
  expect(reads).toHaveLength(0);
  await agrees(page);
  // Row 68, then Back: the 100 rows the address still says.
  await link(page, title(153)).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(153));
  await page.goBack();
  await expect(rows(page)).toHaveCount(100);
  await agrees(page);
  await sortBy(page, 'New');
  await page.waitForURL('**/all?sort=new');
  await expect(rows(page)).toHaveCount(20);
  await agrees(page);
});

test('an address just past the cap reads as the cap', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new&n=201');
  await expect(page).toHaveURL(/\/\?sort=new&n=200$/);
  await expect(rows(page)).toHaveCount(200);
  await agrees(page);
});

test('a period under a sort that has none is dropped, and loading more reads only the batches after it', async ({ page }) => {
  const reads: Request[] = [];
  page.on('request', (request) => isFeedRead(new URL(request.url())) && reads.push(request));
  await gotoHydrated(page, '/all?sort=old&period=week');
  await expect(page).toHaveURL(/\/all\?sort=old$/);
  await loadTo(page, 40);
  await holding(page);
  await agrees(page);
  // The first page came with the document: in the browser, only the batches after it.
  expect(reads.filter((request) => !asks(request, '"cursor"'))).toHaveLength(0);
});

/**
 * Twelve posts arrive above the one the reader opened while they read it: Back puts that post where it stood in
 * the window, in one step (with reduced motion, the window takes no position between the post page's top and it).
 */
async function arrivalsAbove(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await loadTo(page, 60);
  const opened = link(page, title(45));
  await opened.scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  const top = () => opened.evaluate((element) => Math.round(element.getBoundingClientRect().top));
  const offset = await top();
  await opened.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(45));
  run('arrive', seed.suffix, '12');
  try {
    await page.evaluate(() => {
      const at: number[] = [];
      Object.assign(window, { at });
      addEventListener('scroll', () => at.push(Math.round(scrollY)));
    });
    await page.goBack();
    await expect(rows(page)).toHaveCount(count);
    await agrees(page);
    await expect(rows(page).first()).toContainText(`Depth ${seed.suffix} new 12`);
    await expect(opened).toBeInViewport();
    // Within a pixel: rows lie on fractions of one, the window scrolls by whole ones.
    await expect.poll(async () => Math.abs((await top()) - offset)).toBeLessThanOrEqual(1);
    const y = await page.evaluate(() => Math.round(scrollY));
    const at = await page.evaluate(() => (window as unknown as { at: number[] }).at);
    expect(at.filter((value) => value !== 0 && value !== y)).toEqual([]);
  } finally {
    run('depart', seed.suffix);
  }
}

test('posts that arrived above while the reader was away do not move the post they opened: Back puts it where it stood', ({ page }) =>
  arrivalsAbove(page));

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });

  test('posts that arrived above do not move the post the reader opened', ({ page }) => arrivalsAbove(page));

  test("a tap on a row's title puts that row back where it stood", async ({ page }) => {
    await signedIn(page);
    await gotoHydrated(page, '/?sort=new');
    await loadTo(page, 40);
    await opensFromItsRow(page, 30, (row) => row.locator('.pb-post__title a').tap());
  });
});

// The router puts the window back by pixels on its own, so the gone row's fallback is told apart from no anchor
// at all by the Back before it: posts arrived above, and the anchor put the opened post back where it stood.
test('when the post the reader opened is no longer among the fresh rows, Back puts the window where it was', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await loadTo(page, 60);
  const top = (n: number) => link(page, title(n)).evaluate((element) => Math.round(element.getBoundingClientRect().top));
  await link(page, title(45)).scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  const offset = await top(45);
  await link(page, title(45)).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(45));
  run('arrive', seed.suffix, '12');
  try {
    await page.goBack();
    await expect(rows(page)).toHaveCount(count);
    await expect(rows(page).first()).toContainText(`Depth ${seed.suffix} new 12`);
    await expect.poll(async () => Math.abs((await top(45)) - offset)).toBeLessThanOrEqual(1);
    // From there the reader opens another post, which is removed while they read it.
    await link(page, title(40)).scrollIntoViewIfNeeded();
    await settled(page);
    // Near the end of the list, so another batch may have come.
    const now = await holding(page);
    const y = await page.evaluate(() => Math.round(scrollY));
    await link(page, title(40)).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(40));
    run('remove', title(40));
    await page.goBack();
    await expect(rows(page)).toHaveCount(now);
    await agrees(page);
    await expect(link(page, title(40))).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBe(y);
  } finally {
    run('restore', title(40));
    run('depart', seed.suffix);
  }
});

/**
 * The reader comes to the feed from a post by the sidebar's link, not by one of its rows, loads 60 rows, and goes
 * Back to that post. First, with `before`, they press that post's row link in a way that opens nothing in this tab:
 * with a modifier key or the middle button (another tab), a click the page prevented, or a press they took away
 * before letting go. The feed's entry keeps its
 * scroll alone: once the post has moved down the feed, Forward puts the window back by pixels, not by the post.
 */
async function leftForAPostNotOpened(page: Page, before?: 'modified' | 'middle' | 'prevented' | 'cancelled') {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await link(page, title(10)).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(10));
  await page.getByRole('complementary', { name: 'Sidebar' }).locator('a[href="/"]').first().click();
  await page.waitForURL((url) => url.pathname === '/' && url.search === '');
  await loadTo(page, 60);
  await link(page, title(42)).scrollIntoViewIfNeeded();
  await settled(page);
  if (before === 'modified' || before === 'middle') {
    const opened = page.context().waitForEvent('page');
    await link(page, title(10)).click(before === 'modified' ? { modifiers: ['ControlOrMeta'] } : { button: 'middle' });
    await (await opened).close();
    await settled(page);
  } else if (before === 'prevented') {
    await page.evaluate(
      (name) =>
        document.addEventListener(
          'click',
          (event) => event.target instanceof Element && event.target.closest('a')?.textContent === name && event.preventDefault(),
          { capture: true, once: true },
        ),
      title(10),
    );
    await link(page, title(10)).click();
    await settled(page);
    await expect(page).toHaveURL(/\/\?n=60$/);
  } else if (before === 'cancelled') {
    await link(page, title(10)).scrollIntoViewIfNeeded();
    const pressed = (await link(page, title(10)).boundingBox())!;
    const away = (await page.getByRole('complementary', { name: 'Sidebar' }).boundingBox())!;
    await page.mouse.move(pressed.x + 4, pressed.y + pressed.height / 2);
    await page.mouse.down();
    await page.mouse.move(away.x + away.width / 2, away.y + away.height / 2, { steps: 5 });
    await page.mouse.up();
    await settled(page);
    await expect(page).toHaveURL(/\/\?n=60$/);
  }
  const count = await holding(page);
  const y = await page.evaluate(() => Math.round(scrollY));
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(10));
  run('swap', title(10), title(50));
  try {
    await page.goForward();
    await expect(rows(page)).toHaveCount(count);
    await agrees(page);
    await expect(rows(page).nth(49)).toContainText(title(10));
    await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBe(y);
  } finally {
    run('swap', title(10), title(50));
  }
}

test('a feed left by Back for a post it did not open keeps its scroll alone: Forward puts the window back by pixels', ({ page }) =>
  leftForAPostNotOpened(page));

test('a post opened from a row in another tab is not the place of this one', ({ page }) => leftForAPostNotOpened(page, 'modified'));

test('a middle click on a row opens another tab and is not the place of this one', ({ page }) => leftForAPostNotOpened(page, 'middle'));

test('a press on a row link that the page prevented opens nothing and leaves no place behind', ({ page }) =>
  leftForAPostNotOpened(page, 'prevented'));

test('a press on a row link taken away before it is let go opens nothing and leaves no place behind', ({ page }) =>
  leftForAPostNotOpened(page, 'cancelled'));

test("a Card's link to another of the feed's posts makes the card the place, not that post's row", async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await view(page, 'Card');
  // Post 2 links to post 12, on this server.
  const target = await link(page, title(12)).getAttribute('href');
  run('link', title(2), new URL(target!, page.url()).href);
  try {
    await gotoHydrated(page, '/?sort=new');
    const card = rows(page).filter({ has: page.locator('.pb-post__title a', { hasText: new RegExp(`^${title(2)}$`) }) });
    const top = () => card.evaluate((element) => Math.round(element.getBoundingClientRect().top));
    const offset = await top();
    await card.locator('a.pb-post__link').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(12));
    // While the reader is away three posts arrive above the card, and post 12 moves down to row 15.
    run('arrive', seed.suffix, '3');
    run('swap', title(12), title(15));
    try {
      await page.goBack();
      await expect(rows(page)).toHaveCount(20);
      await agrees(page);
      await expect(rows(page).nth(17)).toContainText(title(12));
      await expect.poll(async () => Math.abs((await top()) - offset)).toBeLessThanOrEqual(1);
    } finally {
      run('swap', title(12), title(15));
      run('depart', seed.suffix);
    }
  } finally {
    run('link', title(2));
  }
});

/** Picks a view from the View menu, and waits until it is stored. */
async function view(page: Page, density: 'Card' | 'Classic') {
  const stored = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/_serverFn/'));
  await page.getByRole('button', { name: /^View: / }).click();
  await page.getByRole('menuitem', { name: density, exact: true }).click();
  await stored;
}

/**
 * Answers for the seed's pictures (`picture`, seed-depth.ts): a tall one, 800 by 1000, kept by no cache. While
 * held, each waits until it is let go.
 */
async function servePictures(page: Page) {
  let held = Promise.resolve();
  let release = () => {};
  await page.route('**/depth-pictures/**', async (route) => {
    await held;
    const body = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#888"/></svg>';
    await route.fulfill({ contentType: 'image/svg+xml', headers: { 'cache-control': 'no-store' }, body }).catch(() => undefined);
  });
  return {
    hold: () => void (held = new Promise<void>((resolve) => (release = resolve))),
    release: () => release(),
  };
}

/**
 * The pictures of the posts `titles`, in order: for each, whether its row is there with a picture that has loaded,
 * how the picture is fitted in its box, and the box's width over its height.
 */
const picturesOf = (page: Page, titles: string[]) =>
  page.locator('.feed-list > li').evaluateAll(
    (rows, titles) =>
      titles.map((name) => {
        const row = rows.find((row) => row.querySelector('.pb-post__title a')?.textContent === name);
        const image = row?.querySelector('img');
        const box = row?.querySelector('.pb-post__thumb')?.getBoundingClientRect();
        return {
          loaded: image ? image.complete && image.naturalWidth > 0 : false,
          fit: image ? getComputedStyle(image).objectFit : null,
          ratio: box ? Math.round((box.width / box.height) * 100) / 100 : null,
        };
      }),
    titles,
  );

/** The pictures of `titles` once they have all loaded: each whole in a 16:9 box in Card, cropped to a 4:3 thumbnail in Classic. */
async function picturesLoaded(page: Page, titles: string[], density: 'Card' | 'Classic') {
  await expect.poll(async () => (await picturesOf(page, titles)).every((picture) => picture.loaded)).toBe(true);
  const expected = density === 'Card' ? { loaded: true, fit: 'contain', ratio: 1.78 } : { loaded: true, fit: 'cover', ratio: 1.33 };
  expect(await picturesOf(page, titles)).toEqual(titles.map(() => expected));
}

test('in Card view, pictures that come after Back move nothing: the post the reader opened stays where it stood', async ({ page }) => {
  await signedIn(page);
  const pictures = await servePictures(page);
  await gotoHydrated(page, '/?sort=new');
  await view(page, 'Card');
  await loadTo(page, 40);
  const top = () => link(page, title(30)).evaluate((element) => Math.round(element.getBoundingClientRect().top));
  await link(page, title(30)).scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  const offset = await top();
  await link(page, title(30)).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(30));
  // While the reader is away, the four posts above theirs become picture posts; the pictures come only after Back.
  const above = [title(26), title(27), title(28), title(29)];
  run('picture', 'true', ...above);
  try {
    pictures.hold();
    await page.goBack();
    await expect(rows(page)).toHaveCount(count);
    await agrees(page);
    await expect.poll(async () => Math.abs((await top()) - offset)).toBeLessThanOrEqual(1);
    pictures.release();
    await picturesLoaded(page, above, 'Card');
    await settled(page);
    expect(Math.abs((await top()) - offset)).toBeLessThanOrEqual(1);
  } finally {
    run('picture', 'false', ...above);
  }
});

test('a picture that comes after its row is drawn moves no row, in the views that draw pictures', async ({ page }) => {
  await signedIn(page);
  const pictures = await servePictures(page);
  const shown = [title(2), title(3), title(4)];
  run('picture', 'true', ...shown);
  try {
    for (const density of ['Card', 'Classic'] as const) {
      await gotoHydrated(page, '/?sort=new');
      await view(page, density);
      pictures.hold();
      await gotoHydrated(page, '/?sort=new');
      const tops = () => rows(page).evaluateAll((rows) => rows.slice(0, 8).map((row) => Math.round(row.getBoundingClientRect().top)));
      const before = await tops();
      pictures.release();
      await picturesLoaded(page, shown, density);
      await settled(page);
      expect(await tops(), density).toEqual(before);
    }
  } finally {
    run('picture', 'false', ...shown);
  }
});

/**
 * The reader opens post `at` from its row by `open`; three posts arrive above while they read it. Back puts that
 * row where it stood. Being three rows nearer the end then, the end can come within a screen, and the batch the
 * list asks for waits until these checks are done.
 */
async function opensFromItsRow(page: Page, at: number, open: (row: Locator) => Promise<void>) {
  const row = rows(page).filter({ has: page.locator('.pb-post__title a', { hasText: new RegExp(`^${title(at)}$`) }) });
  await row.scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  const top = () => row.evaluate((element) => Math.round(element.getBoundingClientRect().top));
  const offset = await top();
  await open(row);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(at));
  run('arrive', seed.suffix, '3');
  const batch = (url: URL) => isFeedRead(url) && decodeURIComponent(url.search).includes('"cursor"');
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(batch, async (route) => {
    await released;
    await route.fallback().catch(() => undefined);
  });
  try {
    await page.goBack();
    await expect(rows(page)).toHaveCount(count);
    await expect(rows(page).first()).toContainText(`Depth ${seed.suffix} new 03`);
    await expect.poll(async () => Math.abs((await top()) - offset)).toBeLessThanOrEqual(1);
  } finally {
    release();
    await page.unroute(batch);
    run('depart', seed.suffix);
  }
}

test('every way into a post from its row puts that row back where it stood: Enter on its title, its comments link, its picture', async ({
  page,
}) => {
  await signedIn(page);
  await servePictures(page);
  run('picture', 'true', title(27));
  try {
    await gotoHydrated(page, '/?sort=new');
    await view(page, 'Card');
    await loadTo(page, 40);
    await opensFromItsRow(page, 21, (row) => row.locator('.pb-post__title a').press('Enter'));
    await opensFromItsRow(page, 24, (row) => row.locator('.pb-post__comments').click());
    await opensFromItsRow(page, 27, (row) => row.locator('.pb-post__thumb').click());
  } finally {
    run('picture', 'false', title(27));
  }
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
  await agrees(page);
  await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBe(y);
  // No position between the post page's top and the reader's place: nothing animated the way there.
  const at = await page.evaluate(() => (window as unknown as { at: number[] }).at);
  expect(at.filter((value) => value !== 0 && value !== y)).toEqual([]);
});

test('a reader who scrolls while a return loads is left where the router puts the window, not moved to the row', async ({ page }) => {
  await signedIn(page);
  await gotoHydrated(page, '/?sort=new');
  await loadTo(page, 40);
  await link(page, title(21)).scrollIntoViewIfNeeded();
  await settled(page);
  const count = await holding(page);
  const y = await page.evaluate(() => Math.round(scrollY));
  await link(page, title(21)).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title(21));
  // Posts arrive above, so putting the row back would move the window off where the router puts it.
  run('arrive', seed.suffix, '3');
  const held = await holdReads(page);
  try {
    await page.goBack();
    await expect.poll(() => held.length).toBe(1);
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 300);
    // At rest before the read is let go, so no scroll the wheel started runs on into the feed.
    let last = -1;
    await expect
      .poll(async () => {
        const now = await page.evaluate(() => scrollY);
        const still = now === last;
        last = now;
        return still;
      })
      .toBe(true);
    held[0]!.go();
    await expect(rows(page)).toHaveCount(count);
    await expect(rows(page).first()).toContainText(`Depth ${seed.suffix} new 03`);
    await settled(page);
    // Where the reader left (a click can scroll the link a pixel into view), not three rows further down.
    expect(Math.abs((await page.evaluate(() => Math.round(scrollY))) - y)).toBeLessThanOrEqual(1);
  } finally {
    run('depart', seed.suffix);
  }
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
  await agrees(page);
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
  await agrees(page);
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
  await agrees(page);
  expect(reads).toHaveLength(0);
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('an address with n=60 is drawn with 60 rows by the server, and the next page is a plain link', async ({ page }) => {
    await page.goto('/all?sort=old&n=60');
    await expect(rows(page)).toHaveCount(60);
    await agrees(page);
    await expect(rows(page).first()).toContainText(title(220));
    const next = page.getByRole('link', { name: 'Next page' });
    await expect(next).toHaveAttribute('href', /^\/all\?sort=old&cursor=[^&]+$/);
    // It goes on from the last of the 60.
    await next.click();
    await expect(rows(page).first()).toContainText(title(160));
  });

  test('the sort and Top period already chosen lead to the address shown: the rows stay, and no history entry is added', async ({
    page,
  }) => {
    await page.goto('/all');
    await page.goto('/all?sort=top&period=all&n=60');
    await expect(rows(page)).toHaveCount(60);
    const links = page.locator('.feed-no-script');
    for (const name of ['Top', 'All time']) {
      await expect(links.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      await links.getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL(/\/all\?sort=top&period=all&n=60$/);
      await expect(rows(page)).toHaveCount(60);
    }
    // Another sort or period is another list, from its first batch.
    await expect(links.getByRole('link', { name: 'New', exact: true })).toHaveAttribute('href', '/all?sort=new');
    await expect(links.getByRole('link', { name: 'Week', exact: true })).toHaveAttribute('href', '/all?sort=top&period=week');
    await page.goBack();
    await expect(page).toHaveURL(/\/all$/);
  });
});
