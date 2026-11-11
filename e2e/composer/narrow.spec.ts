import { expect, test, type BrowserContext, type Locator } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';
import { choose, community, radioLabel, seed, type Seed, signedIn } from './support.ts';

// The composer on a 320px screen: a community name or handle with no break in it wraps inside
// the picker's row and the rules aside's Card instead of running past them or being cut off.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.use({ viewport: { width: 320, height: 800 } });

let world: Seed;
let poster: BrowserContext;
test.beforeAll(async ({ browser, baseURL }) => {
  world = seed();
  poster = await signedIn(browser, baseURL!, world.people.poster, world.password);
});
test.afterAll(async () => {
  await poster.close();
});

/** The element's box lies inside the box of `within` (a pixel of rounding allowed) and is not cut off by its own overflow. */
async function inside(element: Locator, within: Locator) {
  const [box, outer] = await Promise.all([element.boundingBox(), within.boundingBox()]);
  expect(box && outer, 'both are on screen').toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(outer!.x - 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 1);
  expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

test('a long community name or handle wraps in the picker and in the rules aside', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  const options = page.locator('.cmp__options');
  for (const handle of [world.communities.long.handle, world.communities.farAway.handle]) {
    const row = radioLabel(community(page, handle));
    await row.scrollIntoViewIfNeeded();
    await inside(row.locator('.pb-handle'), options);
    await inside(row, options);
  }
  await choose(page, world.communities.long.handle);
  const aside = page.getByRole('complementary', { name: 'Community rules' });
  const card = aside.locator('.muxui-card').first();
  const heading = aside.getByRole('heading', { level: 2 });
  await expect(heading).toContainText(world.communities.long.handle);
  await inside(heading, card);
  const rule = aside.getByText('Postsabouttheweatherbelongintheweathercommunityplease');
  await inside(rule, card);
  await inside(aside.getByRole('link', { name: /weather\.far-away\.test/ }), card);
  // Nothing makes the page itself scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.close();
});
