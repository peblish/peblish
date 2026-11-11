import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { community, radioLabel, seed, signedIn, type Seed } from '../composer/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { drawing, pixelDiff, removeNativeStateRules, ringColours, shot } from './support.ts';

// Mux UI draws its radios and checkboxes from data attributes React sets, over a hidden native
// input. packages/ui/src/components/native-state.css draws them from the input while those
// attributes are stale: without JavaScript the drawing follows the visitor's clicks and keys, and
// with JavaScript it changes nothing.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

let world: Seed;
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();
const contexts: BrowserContext[] = [];
test.beforeAll(() => {
  world = seed();
});
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

type Open = { scripts: boolean; as?: string; scheme?: 'light' | 'dark' };

/** A page with or without JavaScript, signed in as `as`, in the scheme the display cookie names. Motion is reduced. */
async function open(browser: Browser, baseURL: string, path: string, { scripts, as, scheme = 'light' }: Open): Promise<Page> {
  if (as && !sessions.has(as)) {
    const context = await signedIn(browser, baseURL, as, world.password);
    sessions.set(as, await context.storageState());
    await context.close();
  }
  const context = await browser.newContext({
    baseURL,
    storageState: as ? sessions.get(as) : undefined,
    javaScriptEnabled: scripts,
    reducedMotion: 'reduce',
  });
  contexts.push(context);
  await context.addCookies([{ name: 'peblish_prefs', value: `density=card&scheme=${scheme}`, url: baseURL }]);
  const page = await context.newPage();
  if (scripts) await gotoHydrated(page, path);
  else await page.goto(path);
  return page;
}

const postType = (page: Page, name: string) => page.getByRole('radio', { name, exact: true });
const radioIndicator = (radio: Locator) => radioLabel(radio).locator('.muxui-radio-field__indicator');
const dot = (radio: Locator) => radioLabel(radio).locator('.muxui-radio-field__dot');
const boxIndicator = (checkbox: Locator) => checkbox.locator('xpath=ancestor::label[1]').locator('.muxui-checkbox-field__indicator');

/** Clicks a checkbox where its box is drawn: the label around it may hold links (the sign-up terms). */
async function tick(checkbox: Locator) {
  const box = await boxIndicator(checkbox).boundingBox();
  if (!box) throw new Error('the checkbox has no drawn box');
  await checkbox.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** The tick a Mux checkbox shows: React's icon when it rendered one, else the stylesheet's mask. */
const tickShown = (checkbox: Locator) =>
  boxIndicator(checkbox).evaluate((box) => {
    const icon = box.querySelector('svg');
    return icon ? getComputedStyle(icon).visibility === 'visible' : getComputedStyle(box, '::after').content !== 'none';
  });

/** `actual` is drawn like `like` and not like `unlike` (pixel shares; edges may differ slightly). */
async function looksLike(browser: Browser, actual: Buffer, like: Buffer, unlike: Buffer) {
  expect(await pixelDiff(browser, actual, like)).toBeLessThan(0.02);
  expect(await pixelDiff(browser, actual, unlike)).toBeGreaterThan(0.05);
}

test.describe('without JavaScript', () => {
  test('the drawn radio follows a click and an arrow key, and keyboard focus shows the ring', async ({ browser, baseURL }) => {
    const page = await open(browser, baseURL!, '/submit', { scripts: false, as: world.people.poster });
    const text = postType(page, 'Text');
    const link = postType(page, 'Link');
    await expect(text).toBeChecked();
    const selected = await shot(radioIndicator(text));
    const unselected = await shot(radioIndicator(link));

    await radioLabel(link).click();
    await expect(link).toBeChecked();
    await expect(dot(link)).toHaveCSS('opacity', '1');
    await expect(dot(text)).toHaveCSS('opacity', '0');
    // Each is drawn as the server drew the other.
    await looksLike(browser, await shot(radioIndicator(link)), selected, unselected);
    await looksLike(browser, await shot(radioIndicator(text)), unselected, selected);
    // A click is not keyboard focus: no ring.
    await expect(radioIndicator(link)).toHaveCSS('outline-style', 'none');

    await page.keyboard.press('ArrowUp');
    await expect(text).toBeChecked();
    await expect(text).toBeFocused();
    await expect(dot(text)).toHaveCSS('opacity', '1');
    await expect(dot(link)).toHaveCSS('opacity', '0');
    await expect(radioIndicator(text)).toHaveCSS('outline-style', 'solid');
    await expect(radioIndicator(link)).toHaveCSS('outline-style', 'none');
    expect(await pixelDiff(browser, await shot(radioIndicator(text)), selected)).toBeGreaterThan(0.1);

    const open_ = community(page, world.communities.open.handle);
    const closed = community(page, world.communities.closed.handle);
    await radioLabel(open_).click();
    await expect(dot(open_)).toHaveCSS('opacity', '1');
    await radioLabel(closed).click();
    await expect(closed).toBeChecked();
    await expect(dot(closed)).toHaveCSS('opacity', '1');
    await expect(dot(open_)).toHaveCSS('opacity', '0');
    await looksLike(browser, await shot(radioIndicator(closed)), selected, unselected);
    await looksLike(browser, await shot(radioIndicator(open_)), unselected, selected);
  });

  test('a box ticked after the server drew it empty shows the tick, and one the server ticked loses it', async ({ browser, baseURL }) => {
    // A refused post comes back with its community and NSFW drawn as chosen by the server.
    const page = await open(browser, baseURL!, '/submit', { scripts: false, as: world.people.banned });
    const nsfw = page.getByRole('checkbox', { name: 'NSFW' });
    const closed = community(page, world.communities.closed.handle);
    const open_ = community(page, world.communities.open.handle);
    const empty = await shot(boxIndicator(nsfw));
    await tick(nsfw);
    await expect(nsfw).toBeChecked();
    expect(await tickShown(nsfw)).toBe(true);
    const ticked = await shot(boxIndicator(nsfw));
    expect(await pixelDiff(browser, ticked, empty)).toBeGreaterThan(0.2);

    await radioLabel(closed).click();
    await page.getByLabel('Title').fill('Drawn without JavaScript');
    await page.getByRole('textbox', { name: 'Body', exact: true }).fill('Body');
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await page.waitForURL(/\/submit\?.*error=community\.banned/);
    await expect(nsfw).toBeChecked();
    await expect(closed).toBeChecked();
    // The server's tick (React's icon) looks like the stylesheet's.
    await looksLike(browser, await shot(boxIndicator(nsfw)), ticked, empty);

    await tick(nsfw);
    await expect(nsfw).not.toBeChecked();
    expect(await tickShown(nsfw)).toBe(false);
    await looksLike(browser, await shot(boxIndicator(nsfw)), empty, ticked);

    await radioLabel(open_).click();
    await expect(dot(closed)).toHaveCSS('opacity', '0');
    await expect(dot(open_)).toHaveCSS('opacity', '1');
  });

  test('ticking the sign-up terms draws the tick', async ({ browser, baseURL }) => {
    const page = await open(browser, baseURL!, '/auth/sign-up', { scripts: false });
    const terms = page.getByRole('checkbox', { name: /I agree to the Terms/ });
    test.skip(
      (await boxIndicator(terms).count()) === 0,
      'the terms box is still a native checkbox (Mux CheckboxField comes with the auth lane)',
    );
    const empty = await shot(boxIndicator(terms));
    await tick(terms);
    await expect(terms).toBeChecked();
    expect(await tickShown(terms)).toBe(true);
    expect(await pixelDiff(browser, await shot(boxIndicator(terms)), empty)).toBeGreaterThan(0.2);
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`with JavaScript the stylesheet changes nothing, and a hydrated control looks like one drawn without it (${scheme})`, async ({
    browser,
    baseURL,
  }) => {
    const as = world.people.poster;
    const pages = [
      await open(browser, baseURL!, '/submit', { scripts: true, as, scheme }),
      await open(browser, baseURL!, '/submit', { scripts: false, as, scheme }),
    ];
    for (const page of pages) {
      await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', scheme);
      await radioLabel(postType(page, 'Link')).click();
      await radioLabel(community(page, world.communities.open.handle)).click();
      await tick(page.getByRole('checkbox', { name: 'NSFW' }));
      // Back to Text by keyboard, so it has keyboard focus.
      await radioLabel(postType(page, 'Link')).click();
      await page.keyboard.press('ArrowUp');
      await expect(postType(page, 'Text')).toBeFocused();
      // Off the controls: the hydrated page draws hover.
      await page.mouse.move(0, 0);
    }
    const [hydrated, plain] = pages as [Page, Page];
    // No transition left running while the styles are read.
    await hydrated.addStyleTag({ content: '*, ::before, ::after { transition: none !important; }' });

    const before = await drawing(hydrated);
    expect(await removeNativeStateRules(hydrated)).toBeGreaterThanOrEqual(10);
    expect(await drawing(hydrated)).toEqual(before);

    const parts = (page: Page) => [
      radioIndicator(postType(page, 'Text')),
      radioIndicator(postType(page, 'Link')),
      radioIndicator(community(page, world.communities.open.handle)),
      boxIndicator(page.getByRole('checkbox', { name: 'NSFW' })),
    ];
    const plainParts = parts(plain);
    for (const [index, part] of parts(hydrated).entries()) {
      // React's tick icon against the stylesheet's mask: the same pixels. Text has keyboard focus: its
      // inside is compared here and its ring by colour below. Mux's ring is a box-shadow and the plain
      // page's two outlines, which can land a pixel apart (Chrome draws Mux's 1.5px border 1px wide at 1x).
      const margin = index === 0 ? -4 : 5;
      expect(await pixelDiff(browser, await shot(part, margin), await shot(plainParts[index]!, margin))).toBe(0);
    }
    const hydratedRing = await ringColours(radioIndicator(postType(hydrated, 'Text')));
    expect(hydratedRing).toHaveLength(2);
    expect(await ringColours(radioIndicator(postType(plain, 'Text')))).toEqual(hydratedRing);
  });
}
