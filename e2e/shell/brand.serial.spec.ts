import { expect, test, type Page } from '@playwright/test';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { readSetting } from '../../packages/core/src/settings/read.ts';
import { seedSetting } from '../../packages/core/src/testing/seed-a.ts';
import type { SiteBrand } from '../../packages/schema/src/site-settings.ts';
import { expectAccessible } from '../auth/support.ts';
import { prefsCookie } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { siteName } from '../support/site-name.ts';

// The instance brand layer (site.brand, packages/ui/src/brand): with no pack the shell is as before packs; with the
// feddit pack, its mark and wordmark, its theme, its icons and its theme colour. It saves site settings every page
// reads, so it is a serial spec, and it puts them back after.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database to set site.brand (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1280, height: 800 } });

let saved: { brand: SiteBrand; name: string } | undefined;
const brand = async (pack: SiteBrand, name: string) => {
  await seedSetting('site.brand', pack);
  await seedSetting('site.name', name);
};
test.beforeAll(async () => {
  saved = { brand: await readSetting('site.brand'), name: await readSetting('site.name') };
});
test.afterAll(async () => {
  if (saved) await brand(saved.brand, saved.name);
  await closePools();
});

/** The wordmark face's load states (one per @font-face of that family), once the page's fonts have settled. */
const wordmarkFaces = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((face) => face.family.replace(/"/g, '') === 'Feddit Wordmark').map((face) => face.status);
  });

test('with no pack the brand is the site name as text, and the head has no pack sheet, icons or theme colour', async ({ page }) => {
  await brand('', 'Brand Test');
  await gotoHydrated(page, '/');
  await expect(page.locator('.pb-brand')).toHaveText('Brand Test');
  await expect(page.locator('.pb-brand')).not.toHaveAttribute('aria-label');
  await expect(page.locator('.pb-brand-lockup')).toHaveCount(0);
  await expect(page.locator('link#pb-brand-css, link[rel="icon"], link[rel="apple-touch-icon"], meta[name="theme-color"]')).toHaveCount(0);
  expect(await siteName(page)).toBe('Brand Test');
});

test("the feddit pack: the mark and the lowercase wordmark in the pack's face, the link named by the site name", async ({ page }) => {
  await brand('feddit', 'Feddit');
  await gotoHydrated(page, '/');
  const home = page.getByRole('link', { name: 'Feddit', exact: true });
  await expect(home).toHaveClass(/pb-brand\b/);
  await expect(home.locator('svg')).toBeVisible();
  const wordmark = home.locator('.pb-brand-lockup__wordmark');
  await expect(wordmark).toHaveText('feddit');
  const face = await wordmark.evaluate((element) => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, weight: style.fontWeight, transform: style.textTransform };
  });
  expect(face).toMatchObject({ family: expect.stringMatching(/^"Feddit Wordmark",/), weight: '700', transform: 'lowercase' });
  expect(await wordmarkFaces(page)).toEqual(['loaded']);
  expect(await siteName(page)).toBe('Feddit');
  await expect(page).toHaveTitle(/· Feddit$/);
  // The pack's tokens reach the page: its brand blue, its doubled radii and medium labels.
  const tokens = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const token = (name: string) => root.getPropertyValue(name).trim();
    return {
      brand: token('--muxui-reference-color-brand-60'),
      radius: token('--muxui-reference-dimension-radius-m'),
      label: token('--muxui-semantic-typography-label-weight'),
    };
  });
  expect(tokens).toEqual({ brand: '#007ba7', radius: '1rem', label: '500' });
  await expectAccessible(page);
});

test('the head links the pack sheet and its icons, all served, and a theme colour per scheme', async ({
  page,
  request,
  context,
  baseURL,
}) => {
  await brand('feddit', 'Feddit');
  await gotoHydrated(page, '/');
  const links = await page
    .locator('link#pb-brand-css, link[rel="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((nodes) => nodes.map((node) => ({ rel: node.getAttribute('rel')!, href: node.getAttribute('href')! })));
  expect(links.map(({ rel }) => rel)).toEqual(['stylesheet', 'icon', 'icon', 'apple-touch-icon']);
  const types = { stylesheet: /text\/css/, icon: /image\/(svg\+xml|png)/, 'apple-touch-icon': /image\/png/ } as const;
  for (const { rel, href } of links) {
    const response = await request.get(href, { headers: { accept: rel === 'stylesheet' ? 'text/css' : 'image/*' } });
    expect(response.status(), href).toBe(200);
    expect(response.headers()['content-type'], href).toMatch(types[rel as keyof typeof types]);
  }
  // The system's scheme: both colours by media query; a chosen scheme: its own.
  const colours = () => page.locator('meta[name="theme-color"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('content')));
  expect(await colours()).toEqual(['#f1f4f6', '#242a2f']);
  await context.addCookies([{ ...prefsCookie('card', 'dark'), url: baseURL }]);
  await gotoHydrated(page, '/');
  expect(await colours()).toEqual(['#242a2f']);
});

test('on a phone the bar shows the mark alone, named by the site name, and the wordmark face is not fetched', async ({ browser }) => {
  await brand('feddit', 'Feddit');
  const page = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  try {
    await gotoHydrated(page, '/');
    const bar = page.locator('.pb-bar-brand');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAccessibleName('Feddit');
    await expect(bar.locator('svg')).toBeVisible();
    await expect(bar).toHaveText('');
    expect(await wordmarkFaces(page)).toEqual(['unloaded']);
    await expectAccessible(page);
  } finally {
    await page.context().close();
  }
});

test("a site name without the wordmark shows beside the mark instead, so the link's name holds what it shows", async ({ page }) => {
  await brand('feddit', 'Acme Commons');
  await gotoHydrated(page, '/');
  const home = page.locator('.pb-brand');
  await expect(home).toHaveAccessibleName('Acme Commons');
  await expect(home).toHaveText('Acme Commons');
  await expect(home.locator('svg')).toBeVisible();
  await expect(home.locator('.pb-brand-lockup__wordmark')).toHaveCount(0);
  await expectAccessible(page);
});

test('in dark, the pack keeps the brand and the page accessible', async ({ page, context, baseURL }) => {
  await brand('feddit', 'Feddit');
  await context.addCookies([{ ...prefsCookie('card', 'dark'), url: baseURL }]);
  await gotoHydrated(page, '/');
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', 'dark');
  await expect(page.getByRole('link', { name: 'Feddit', exact: true }).locator('.pb-brand-lockup__wordmark')).toHaveText('feddit');
  await expectAccessible(page);
});
