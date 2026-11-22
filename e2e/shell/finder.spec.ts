import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type Request } from '@playwright/test';
import { expectAccessible, landed, signIn, signOut } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The header's finder (shell/header.tsx, shell/finder/): opened by the header's link over the page, its rows in named
// groups from the directory's search, keyboard-complete, a pasted handle sent to the resolve form only when chosen.
// That typing writes nothing is finder-writes.serial.spec.ts. Seeds the lane database (e2e/shell/finder-seed.ts), so against a remote BASE_URL it
// skips.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.setTimeout(90_000);

const root = join(import.meta.dirname, '../..');
type Cast = {
  password: string;
  person: string;
  word: string;
  host: string;
  communities: Record<'brew' | 'bake' | 'kiln' | 'glaze', { id: string; handle: string; title: string }>;
  hidden: { word: string } & Record<
    'shown' | 'asked' | 'adult' | 'walled' | 'muted' | 'shunned' | 'fading',
    { id: string; handle: string; title: string }
  >;
};
const run = (...args: string[]) => JSON.parse(execFileSync('node', ['e2e/shell/finder-seed.ts', ...args], { cwd: root, encoding: 'utf8' }));

let cast: Cast;
let member: BrowserContext;

async function signedIn(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const first = await browser.newContext({ baseURL });
  const page = await first.newPage();
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${cast.person}`, cast.password);
  await landed(page, '/');
  const state = await first.storageState();
  await first.close();
  return browser.newContext({ baseURL, storageState: state, viewport: { width: 1440, height: 900 } });
}

test.beforeAll(async ({ browser, baseURL }) => {
  cast = run();
  member = await signedIn(browser, baseURL!);
});
test.afterAll(() => member.close());

const finderLink = (page: Page) => page.getByRole('banner').getByRole('link', { name: 'Find a community' });
const finder = (page: Page) => page.getByRole('dialog', { name: 'Find a community' });
const field = (page: Page) => finder(page).getByRole('searchbox', { name: 'Find a community' });
const group = (page: Page, name: string) => finder(page).getByRole('group', { name });
const rows = (page: Page, name: string) => group(page, name).getByRole('option');
/** The row the arrows have reached: the field's active descendant. */
const highlighted = (page: Page) =>
  field(page).evaluate((input) => document.getElementById(input.getAttribute('aria-activedescendant') ?? '')?.textContent ?? '');

async function open(page: Page, path = '/') {
  await gotoHydrated(page, path);
  await finderLink(page).click();
  await expect(field(page)).toBeFocused();
}

test('the finder lists only the followed communities the server lets this viewer see now, in rows, count and timing', async () => {
  const { hidden } = cast;
  const page = await member.newPage();
  await gotoHydrated(page, '/');
  // Removed once the page has loaded: what the page was sent still lists it.
  run('remove', hidden.fading.id);
  // Every answer is held a moment: nothing of the member's own is drawn before the server says it may be.
  let answers = 0;
  await page.route('**/_serverFn/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
    answers++;
  });
  await finderLink(page).click();
  await expect(field(page)).toBeFocused();
  await page.keyboard.type(hidden.word);
  await page.waitForTimeout(700);
  expect(answers).toBe(0);
  await expect(finder(page).getByRole('option')).toHaveCount(0);
  // Answered: the one joined and the one asked to join, though the directory's first page is full of others; none
  // age-gated, on a blocked host, blocked by the member, on an instance they blocked, or removed.
  await expect(rows(page, 'Joined')).toHaveText([new RegExp(`^${hidden.asked.title}`), new RegExp(`^${hidden.shown.title}`)]);
  await expect(rows(page, 'Joined').first()).toContainText('request pending');
  await expect(rows(page, 'More communities')).toHaveCount(25);
  await expect(finder(page).getByRole('status')).toHaveText('27 communities');
  for (const name of ['adult', 'walled', 'muted', 'shunned', 'fading'] as const)
    await expect(finder(page).getByRole('option', { name: new RegExp(hidden[name].title) })).toHaveCount(0);
  await page.close();
});

test('the link opens the finder, whose rows are in named groups, read as one list by the arrows, and Enter opens one', async () => {
  const page = await member.newPage();
  await open(page);
  await page.keyboard.type(cast.word);
  const { brew, bake, kiln, glaze } = cast.communities;
  await expect(rows(page, 'Joined')).toHaveText([new RegExp(brew.title), new RegExp(`${kiln.title}.*request pending`)]);
  await expect(rows(page, 'More communities')).toHaveText([new RegExp(bake.title), new RegExp(glaze.title)]);
  // The count, politely, once the answer is in.
  await expect(finder(page).getByRole('status')).toHaveText('4 communities');
  await expectAccessible(page);
  // The first row is ready for Enter; the arrows run on from one group into the next.
  await expect.poll(() => highlighted(page)).toContain(brew.title);
  for (const next of [kiln, bake, glaze]) {
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => highlighted(page)).toContain(next.title);
  }
  await page.keyboard.press('Enter');
  await landed(page, `/c/${glaze.handle}`);
  await expect(finder(page)).toHaveCount(0);
  await page.close();
});

test('a search for a host finds the communities on it, and a handle finds a joined one by it', async () => {
  const page = await member.newPage();
  await open(page);
  await page.keyboard.type(cast.host);
  await expect(rows(page, 'Joined')).toHaveText([new RegExp(cast.communities.kiln.title)]);
  await expect(rows(page, 'More communities')).toHaveText([new RegExp(cast.communities.glaze.title)]);
  await page.close();
});

test('Escape empties the field, then closes the finder and gives focus back to the link', async () => {
  const page = await member.newPage();
  await open(page);
  await page.keyboard.type(cast.word);
  await expect(rows(page, 'Joined')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(field(page)).toHaveValue('');
  await expect(finder(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(finder(page)).toHaveCount(0);
  await expect(finderLink(page)).toBeFocused();
  // Clear empties it too, and leaves it open.
  await finderLink(page).click();
  await page.keyboard.type(cast.word);
  await finder(page).getByRole('button', { name: 'Clear' }).click();
  await expect(field(page)).toHaveValue('');
  await expect(finder(page)).toBeVisible();
  // Emptied by Clear, the field is empty for Escape too: one press closes.
  await field(page).focus();
  await page.keyboard.press('Escape');
  await expect(finder(page)).toHaveCount(0);
  await page.close();
});

test('a pasted handle is one row, sent to the resolve form only when chosen; one held here opens its page', async () => {
  const page = await member.newPage();
  await open(page);
  const { kiln } = cast.communities;
  const posts: string[] = [];
  page.on('request', (request) => request.method() === 'POST' && posts.push(new URL(request.url()).pathname));
  await page.keyboard.type(`!${kiln.handle}`);
  const lookup = rows(page, 'Find by handle');
  await expect(lookup).toHaveText([new RegExp(`Find !${kiln.handle}.*Asks ${cast.host}`)]);
  // The joined community answers to its handle too, above the row.
  await expect(rows(page, 'Joined')).toHaveCount(1);
  await expect(finder(page).getByRole('status')).toHaveText('1 community, and the handle to find');
  expect(posts).toEqual([]);
  await lookup.click();
  await landed(page, `/c/${kiln.handle}`);
  expect(posts).toEqual(['/resolve']);
  await expect(finder(page)).toHaveCount(0);
  await page.close();
});

test('a lookup is let go once the text changes: its answer, when it comes, moves nothing', async () => {
  const page = await member.newPage();
  await page.route('**/resolve', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    // The finder may have aborted it by now.
    await route.fulfill({ json: { redirect: `/c/${cast.communities.kiln.handle}` } }).catch(() => undefined);
  });
  await open(page);
  await page.keyboard.type(`!${cast.communities.kiln.handle}`);
  await rows(page, 'Find by handle').click();
  await field(page).fill(cast.word);
  await expect(rows(page, 'Joined')).toHaveCount(2);
  await page.waitForTimeout(2_500);
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(field(page)).toHaveValue(cast.word);
  await page.close();
});

test('a visitor’s lookup row opens the lookup page, which says who may ask', async ({ page }) => {
  await open(page);
  await page.keyboard.type('!somewhere@far.example');
  await expect(group(page, 'Joined')).toHaveCount(0);
  await rows(page, 'Find by handle').click();
  await landed(page, /\/resolve\?q=/);
  await expect(page.getByRole('heading', { name: 'Sign in to find things on other servers' })).toBeVisible();
});

test('an answer for older text is dropped, and the list keeps its height while the next one is on its way', async () => {
  const page = await member.newPage();
  await open(page);
  await expect(rows(page, 'Joined').first()).toBeVisible();
  const results = finder(page).locator('.pb-finder__results');
  const height = (await results.boundingBox())!.height;
  // Every answer for the first text arrives late; the newer text's arrive at once.
  await page.route('**/_serverFn/**', async (route) => {
    if (decodeURIComponent(route.request().url()).includes(`bake_${cast.word}`) && !route.request().url().includes('glaze')) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue().catch(() => undefined);
  });
  await page.keyboard.type(`bake_${cast.word}`);
  await page.waitForTimeout(400);
  await field(page).fill(`glaze_${cast.word}`);
  await expect(rows(page, 'More communities')).toHaveText([new RegExp(cast.communities.glaze.title)]);
  await page.waitForTimeout(1800);
  await expect(rows(page, 'More communities')).toHaveText([new RegExp(cast.communities.glaze.title)]);
  expect((await results.boundingBox())!.height).toBe(height);
  await page.close();
});

test('a failed answer says so with Retry, which asks again', async () => {
  const page = await member.newPage();
  let fail = true;
  await page.route('**/_serverFn/**', (route) =>
    fail && decodeURIComponent(route.request().url()).includes(cast.word) ? route.abort() : route.continue(),
  );
  await open(page);
  await page.keyboard.type(cast.word);
  await expect(finder(page).getByText('The communities could not be loaded.')).toBeVisible();
  fail = false;
  await finder(page).getByRole('button', { name: 'Try again' }).click();
  await expect(rows(page, 'Joined')).toHaveCount(2);
  await expect(finder(page).getByText('The communities could not be loaded.')).toHaveCount(0);
  await page.close();
});

test('the finder’s code loads when it is first wanted, not with the page', async () => {
  const page = await member.newPage();
  const scripts: string[] = [];
  let loaded = 0;
  page.on('request', (request) => request.resourceType() === 'script' && scripts.push(request.url()));
  const settled = (request: Request) => void (request.resourceType() === 'script' && loaded++);
  page.on('requestfinished', settled);
  page.on('requestfailed', settled);
  await gotoHydrated(page, '/');
  // The popup and its data (shell/finder/), the panel (community-finder), Mux's palette, and the gallery's samples of it.
  const finderCode = (url: string) => /[/](finder|community-finder|command-palette|-finder-samples)(\.tsx|-[\w-]+\.js)/.test(url);
  expect(scripts.filter(finderCode)).toEqual([]);
  // Hovering fetches code (whatever its chunks are named in a build), and that is all the finder needs: with every
  // further script refused, a press still opens it.
  const before = scripts.length;
  await finderLink(page).hover();
  await expect.poll(() => scripts.length).toBeGreaterThan(before);
  // Settled: every script asked for has arrived, and none more was asked for over half a second.
  let seen = -1;
  await expect
    .poll(
      () => {
        const settled = loaded === scripts.length && scripts.length === seen;
        seen = scripts.length;
        return settled;
      },
      { intervals: [500] },
    )
    .toBe(true);
  await page.route('**/*', (route) => (route.request().resourceType() === 'script' ? route.abort() : route.continue()));
  await finderLink(page).click();
  await expect(field(page)).toBeFocused();
  await page.close();
});

/** The finder's own module (its chunk in a build). */
const finderModule = (url: URL) => /\/shell\/finder\/finder\.tsx$|\/finder-[\w-]+\.js$/.test(url.pathname);

test('a press before the finder’s code is in shows the finder loading at once, then its field', async ({ browser, baseURL }) => {
  // A browser that has not loaded it yet.
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(finderModule, async (route) => {
    await held;
    await route.continue();
  });
  await gotoHydrated(page, '/');
  await finderLink(page).click();
  const pending = page.locator('.pb-finder-pending');
  await expect(pending).toBeVisible({ timeout: 1_000 });
  await expect(pending.getByRole('status')).toHaveText('Loading communities');
  release();
  await expect(field(page)).toBeFocused();
  await expect(pending).toHaveCount(0);
  await context.close();
});

test('a press before the finder’s code is in holds focus on the link: Tab stays, Escape lets go, and closing returns there', async ({
  browser,
  baseURL,
}) => {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
    const page = await context.newPage();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(finderModule, async (route) => {
      await held;
      await route.continue();
    });
    await gotoHydrated(page, '/');
    const link =
      width > 860 ? finderLink(page) : page.getByRole('navigation', { name: 'Page' }).getByRole('link', { name: 'Find a community' });
    const pending = page.locator('.pb-finder-pending');
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(pending).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(link, `${width}px, Tab`).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(link, `${width}px, Shift+Tab`).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(pending).toHaveCount(0);
    await expect(link).toBeFocused();
    // Asked again, it opens once its code is in, and closing it returns focus to the link.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    release();
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(link, `${width}px, after closing`).toBeFocused();
    await context.close();
  }
});

test('an open let go before its code arrives stays let go, even when that code then fails to load', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  let fail = () => {};
  const failing = new Promise<void>((resolve) => (fail = resolve));
  await page.route(finderModule, async (route) => {
    await failing;
    await route.abort();
  });
  await gotoHydrated(page, '/');
  await finderLink(page).click();
  const pending = page.locator('.pb-finder-pending');
  await expect(pending).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pending).toHaveCount(0);
  fail();
  await page.waitForTimeout(1_500);
  expect(new URL(page.url()).pathname).toBe('/');
  await context.close();
});

test('a finder whose code cannot load leaves for the directory, as its link does without scripts', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.route(finderModule, (route) => route.abort());
  await gotoHydrated(page, '/');
  await finderLink(page).click();
  await page.waitForURL('**/communities');
  await context.close();
});

test('on a phone the top bar’s icon opens the finder across the window, under the bar', async () => {
  const page = await member.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoHydrated(page, '/');
  const bar = page.getByRole('navigation', { name: 'Page' });
  const icon = bar.getByRole('link', { name: 'Find a community' });
  await icon.click();
  await expect(field(page)).toBeFocused();
  await page.keyboard.type(cast.word);
  await expect(rows(page, 'Joined')).toHaveCount(2);
  const [popup, top] = await Promise.all([finder(page).boundingBox(), bar.boundingBox()]);
  expect(popup!.width).toBeGreaterThanOrEqual(390 * 0.9);
  expect(popup!.y).toBeGreaterThanOrEqual(top!.y + top!.height - 1);
  for (const row of await rows(page, 'Joined').all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(icon).toBeFocused();
  await page.close();
});

/** What the browser does when the person comes back to the tab (headless pages are always "visible", so hide it first). */
async function showAgain(page: Page) {
  await page.evaluate(() => {
    const set = (state: string) => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    set('hidden');
    set('visible');
  });
}

test('another account in another tab starts an open finder over, and a refresh for the same viewer keeps its text', async ({
  browser,
  baseURL,
}) => {
  // A session of its own: signing it out leaves the other tests' session alone.
  const context = await signedIn(browser, baseURL!);
  const page = await context.newPage();
  await open(page);
  await page.keyboard.type(cast.word);
  await expect(rows(page, 'Joined')).toHaveCount(2);

  // The shell reloads its data for the same viewer (shell/viewer-sync.ts, here told someone else was seen last).
  await page.evaluate(() => localStorage.setItem('pb-viewer', 'someone-else'));
  const refreshed = page.waitForRequest((request) => request.url().includes('/_serverFn/'));
  await showAgain(page);
  await refreshed;
  await page.waitForLoadState('networkidle');
  await expect(field(page)).toHaveValue(cast.word);
  await expect(rows(page, 'Joined')).toHaveCount(2);

  // Signed out in another tab, then shown again: the finder is a visitor's, with nothing of the member's left.
  const other = await context.newPage();
  await signOut(other);
  await expect.poll(() => other.evaluate(() => localStorage.getItem('pb-viewer'))).toBe('');
  await showAgain(page);
  await expect(field(page)).toHaveValue('');
  await page.keyboard.type(cast.word);
  await expect(rows(page, 'More communities')).toHaveCount(4);
  await expect(group(page, 'Joined')).toHaveCount(0);
  await context.close();
});

test('the link draws hover, keeps a system-coloured edge and label in forced colours, and never eases under reduced motion', async ({
  browser,
  baseURL,
}) => {
  const look = (link: Locator) =>
    link.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        edge: style.borderTopColor,
        width: style.borderTopWidth,
        label: style.color,
        ground: style.backgroundColor,
        eases: style.transitionDuration,
      };
    });
  for (const forced of [false, true]) {
    const context = await browser.newContext({ baseURL, reducedMotion: 'reduce', forcedColors: forced ? 'active' : 'none' });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoHydrated(page, '/');
    const link = finderLink(page);
    await page.mouse.move(0, 0);
    const rest = await look(link);
    await link.hover();
    const hover = await look(link);
    await page.mouse.down();
    const press = await look(link);
    await page.mouse.up();
    await expect(field(page)).toBeFocused();
    // No state eases: every duration is zero.
    for (const state of [rest, hover, press]) expect(state.eases.split(', ').every((duration) => duration === '0s')).toBe(true);
    if (forced) {
      // The edge and the label are a system colour (the browser's link colour here), apart from the ground.
      expect(rest.width).toBe('1px');
      expect(rest.edge).toBe(rest.label);
      expect(rest.label).not.toBe(rest.ground);
    } else {
      // Hover: a stronger edge and the full text colour.
      expect(hover.edge).not.toBe(rest.edge);
      expect(hover.label).not.toBe(rest.label);
    }
    // The phone's icon keeps an edge in forced colours (its transparent border is drawn then).
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    const icon = page.getByRole('navigation', { name: 'Page' }).getByRole('link', { name: 'Find a community' });
    const phone = await look(icon);
    if (forced) expect(phone.edge).toBe(phone.label);
    expect(phone.eases.split(', ').every((duration) => duration === '0s')).toBe(true);
    await context.close();
  }
});

test('the link says whether the finder is open and names it, and draws pressed, open and a forced-colours hover', async ({
  browser,
  baseURL,
}) => {
  const background = (link: Locator) => link.evaluate((element) => getComputedStyle(element).backgroundColor);
  const context = await browser.newContext({ baseURL, reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await gotoHydrated(page, '/');
  const link = finderLink(page);
  await expect(link).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.move(0, 0);
  const rest = await background(link);
  await link.hover();
  await page.mouse.down();
  const pressed = await background(link);
  await page.mouse.up();
  await expect(field(page)).toBeFocused();
  await expect(link).toHaveAttribute('aria-expanded', 'true');
  await expect(finder(page)).toHaveAttribute('id', (await link.getAttribute('aria-controls'))!);
  // On a desktop the popup stays where Mux puts it, across the middle of the window.
  const popup = (await finder(page).boundingBox())!;
  expect(Math.abs(popup.x + popup.width / 2 - 720)).toBeLessThanOrEqual(1);
  await page.mouse.move(0, 0);
  const opened = await background(link);
  expect(pressed).not.toBe(rest);
  expect(opened).not.toBe(rest);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(link).toHaveAttribute('aria-expanded', 'false');
  await expect(link).not.toHaveAttribute('aria-controls');
  await context.close();

  // Forced colours keep no background or edge colour of the page's own: hover draws an outline.
  const forced = await browser.newContext({
    baseURL,
    forcedColors: 'active',
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 900 },
  });
  const high = await forced.newPage();
  await gotoHydrated(high, '/');
  await high.mouse.move(0, 0);
  const outline = (link: Locator) => link.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(await outline(finderLink(high))).toBe('none');
  await finderLink(high).hover();
  expect(await outline(finderLink(high))).toBe('solid');
  await forced.close();
});

for (const width of [320, 390]) {
  test(`at ${width}px the finder is a full-width field just under the top bar, with or without a banner above the bar`, async () => {
    const page = await member.newPage();
    await page.setViewportSize({ width, height: 800 });
    for (const banner of [false, true]) {
      await gotoHydrated(page, '/');
      // A banner above the frame (another lane's): a strip at the top of the page that moves the bar down.
      if (banner)
        await page.evaluate(() => document.body.prepend(Object.assign(document.createElement('div'), { className: 'pb-test-banner' })));
      if (banner) await page.addStyleTag({ content: '.pb-test-banner { block-size: 56px; }' });
      const bar = page.getByRole('navigation', { name: 'Page' });
      const box = (await bar.boundingBox())!;
      if (banner) expect(box.y).toBeGreaterThanOrEqual(56);
      await bar.getByRole('link', { name: 'Find a community' }).click();
      await expect(field(page)).toBeFocused();
      const popup = (await finder(page).boundingBox())!;
      expect(Math.abs(popup.y - (box.y + box.height)), `banner ${banner}`).toBeLessThanOrEqual(1);
      expect(popup.x).toBeLessThanOrEqual(1);
      expect(popup.width).toBeGreaterThanOrEqual(width - 1);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    }
    await page.close();
  });
}

test('with scripts off the link is the directory', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/');
  await finderLink(page).click();
  await page.waitForURL('**/communities');
  await context.close();
});
