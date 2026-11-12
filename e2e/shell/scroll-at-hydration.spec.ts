import { expect, test, type Page, type Route } from '@playwright/test';
import { seedWorld, type World } from '../modlog/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// Where the page is scrolled. The router restores scroll positions, and a page the server rendered
// carries its inline script, which puts the page where it was (or at the top, or at the #fragment)
// before the first paint. The router's own first render used to do it again at hydration: a reader
// who had already scrolled was thrown back to the top, and a press made while the page hydrated was
// released over whatever had moved under the pointer, so it was lost (the Bans tab's Ban button at
// 6x CPU throttling, e2e/bans/bans.spec.ts). The other cases here are what restoration must keep doing.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ timeout: 90_000 });
// Short enough that every page here scrolls.
test.use({ viewport: { width: 1280, height: 300 } });

let world: World;
test.beforeAll(() => {
  world = seedWorld();
});

/** Holds back the page's scripts until the returned function is called; later ones pass at once. */
async function holdScripts(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/assets/**/*.js', async (route: Route) => {
    await gate;
    await route.continue();
  });
  return release;
}

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));
const hydrated = (page: Page) => page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
const notHydrated = async (page: Page) => expect(await page.evaluate(() => document.documentElement.dataset.hydrated)).toBeUndefined();

/** Scrolls as a reader does, with the wheel, and returns where the page came to rest. */
async function wheel(page: Page, by: number): Promise<number> {
  const before = await scrollY(page);
  await page.mouse.move(640, 150);
  await page.mouse.wheel(0, by);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(before);
  let last = -1;
  await expect
    .poll(async () => {
      const now = await scrollY(page);
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
  return last;
}

/**
 * Whether the page is where the browser itself puts it for the anchor `#id` (scrolled into view,
 * as far as the page's length allows), and the page did move to get there.
 */
const onAnchor = (page: Page, id: string) =>
  page.evaluate((anchor) => {
    const target = document.getElementById(anchor);
    if (!target) return false;
    const here = Math.round(window.scrollY);
    target.scrollIntoView();
    const there = Math.round(window.scrollY);
    window.scrollTo(0, here);
    return here > 0 && here === there;
  }, id);

test('a fresh load the reader scrolls before it hydrates stays where they scrolled it', async ({ page }) => {
  const scripts = await holdScripts(page);
  await page.goto('/', { waitUntil: 'commit' });
  await page.locator('main').waitFor();
  const scrolled = await wheel(page, 900);
  await notHydrated(page);
  scripts();
  await hydrated(page);
  await page.waitForTimeout(300);
  expect(await scrollY(page)).toBe(scrolled);
});

test('a reload goes back to where the page was, and a scroll made before it hydrates is kept', async ({ page }) => {
  await gotoHydrated(page, '/');
  const saved = await wheel(page, 700);
  await page.reload({ waitUntil: 'commit' });
  await hydrated(page);
  await expect.poll(() => scrollY(page)).toBe(saved);

  const scripts = await holdScripts(page);
  await page.reload({ waitUntil: 'commit' });
  await page.locator('main').waitFor();
  await expect.poll(() => scrollY(page)).toBe(saved);
  const further = await wheel(page, 500);
  scripts();
  await hydrated(page);
  await page.waitForTimeout(300);
  expect(await scrollY(page)).toBe(further);
});

test('a link opens its page at the top, and back and forward return to where each page was', async ({ page }) => {
  await gotoHydrated(page, '/');
  await wheel(page, 900);
  const link = page.locator('main a[href^="/post/"]').filter({ visible: true }).nth(2);
  await link.scrollIntoViewIfNeeded();
  const feed = await scrollY(page);
  expect(feed).toBeGreaterThan(0);
  const href = (await link.getAttribute('href'))!;
  await link.click();
  await expect(page).toHaveURL(href);
  await expect.poll(() => scrollY(page)).toBe(0);
  const post = await wheel(page, 150);
  await page.goBack();
  await expect(page).toHaveURL('/');
  await expect.poll(() => scrollY(page)).toBe(feed);
  await page.goForward();
  await expect(page).toHaveURL(href);
  await expect.poll(() => scrollY(page)).toBe(post);
});

test('a position kept at hydration is where Back returns to, with no scroll after it', async ({ page }) => {
  // The post page, whose height is final as it renders. (Back to a deep place on the feed or the
  // directory lands short whenever the reader scrolled, on main as well: in the lane notes.)
  const post = `/post/${world.posts.author}`;
  const scripts = await holdScripts(page);
  await page.goto(post, { waitUntil: 'commit' });
  await page.locator('main').waitFor();
  const scrolled = await wheel(page, 150);
  scripts();
  await hydrated(page);
  await page.waitForTimeout(300);
  expect(await scrollY(page)).toBe(scrolled);
  // A link already on screen, so following it scrolls nothing first.
  const href = await page.evaluate((here) => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>('main a[href^="/"]')].find((candidate) => {
      const box = candidate.getBoundingClientRect();
      return !candidate.getAttribute('href')!.startsWith(here) && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight;
    });
    link?.setAttribute('data-pick', '');
    return link?.getAttribute('href') ?? null;
  }, post);
  expect(href).not.toBeNull();
  await page.locator('[data-pick]').click();
  await expect(page).not.toHaveURL(post);
  await page.goBack();
  await expect(page).toHaveURL(post);
  await expect.poll(() => scrollY(page)).toBe(scrolled);
});

test('a link to an anchor lands on it, on the same page, on another address, and on a fresh load', async ({ page }) => {
  await gotoHydrated(page, `/post/${world.posts.author}`);
  expect(await scrollY(page)).toBe(0);
  await page.locator('main a[href="#comments"]').click();
  await expect(page).toHaveURL(/#comments$/);
  await expect.poll(() => onAnchor(page, 'comments')).toBe(true);

  // The thread's sort is a form the router turns into a navigation to ?sort=old#comments.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Old' }).click();
  await expect(page).toHaveURL(/\?sort=old#comments$/);
  await expect.poll(() => onAnchor(page, 'comments')).toBe(true);

  await page.goto('/', { waitUntil: 'commit' });
  await hydrated(page);
  await page.goto(`/post/${world.posts.author}#comments`, { waitUntil: 'commit' });
  await hydrated(page);
  await page.waitForTimeout(300);
  expect(await onAnchor(page, 'comments')).toBe(true);
});

test('a press begun before the page hydrates, on a link scrolled to, still follows it', async ({ page }) => {
  const scripts = await holdScripts(page);
  await page.goto('/', { waitUntil: 'commit' });
  await page.locator('main').waitFor();
  await wheel(page, 900);
  const link = page.locator('main a[href^="/post/"]').filter({ visible: true }).nth(2);
  await link.scrollIntoViewIfNeeded();
  const scrolled = await scrollY(page);
  expect(scrolled).toBeGreaterThan(0);
  const href = (await link.getAttribute('href'))!;
  const box = (await link.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await notHydrated(page);
  scripts();
  await hydrated(page);
  // The page stays where it was scrolled, so the release lands on the link it was pressed on.
  await page.waitForTimeout(300);
  expect(await scrollY(page)).toBe(scrolled);
  await page.mouse.up();
  await expect(page).toHaveURL(href);
});
