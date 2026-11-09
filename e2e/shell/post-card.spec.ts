import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// PostCard loads a thumbnail only from the source its page resolved (the renderer's image()
// helper), never from the post's own thumbnailUrl: a raw remote URL would hand the viewer's
// address to that host. The gallery's "withheld" post names a remote thumbnail but is given none.
test.beforeEach(({ request }) => skipWithoutKit(request));

test('a thumbnail the page did not resolve is neither shown nor requested', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await gotoHydrated(page, '/kit');
  await page.waitForLoadState('networkidle');

  const card = page.getByTestId('kit-withheld').locator('article');
  await expect(card.locator('img')).toHaveCount(0);
  await expect(card.locator('.pb-post__mark')).toBeVisible();
  expect(requested.filter((url) => url.includes('tracker.example'))).toEqual([]);

  // Every picture in the gallery comes from a resolved source: a data URI here, or this origin.
  const sources = await page.locator('article img').evaluateAll((images) => images.map((image) => image.getAttribute('src') ?? ''));
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.filter((src) => !src.startsWith('data:') && !src.startsWith('/'))).toEqual([]);
});
