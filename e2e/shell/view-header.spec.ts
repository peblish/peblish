import { expect, test } from '@playwright/test';
import { recordConsole } from '../support/route-marker.ts';

// The bar's title shows once the page's h1 has scrolled under it (useHeadingInView, shell/view-header.tsx),
// measured from the bar's lower edge when the page hydrates. The bar sticks inside its column, so a page the
// reader scrolled past the column's end before it hydrated has the bar above the window, and the observer
// that watches the heading must still be made with a margin it accepts.
test.use({ viewport: { width: 1280, height: 400 } });

test('a page that hydrates with its bar scrolled out of the window still hydrates cleanly', async ({ page }) => {
  // A document longer than the frame, without a change to the page's markup, so hydration sees the server's.
  await page.addInitScript(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('body::after { content: ""; display: block; block-size: 300vh; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
  const log = recordConsole(page);
  // The scripts wait until the page has been scrolled.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'script') await gate;
    await route.fallback();
  });
  await page.goto('/about', { waitUntil: 'commit' });
  await page.locator('#pb-main main h1').waitFor();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const bar = page.locator('#pb-main > .pb-frame-vh');
  expect(await bar.evaluate((node) => node.getBoundingClientRect().bottom)).toBeLessThan(0);

  release();
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await page.waitForTimeout(300);
  expect(log.problems().filter(({ text }) => /IntersectionObserver|rootMargin/.test(text))).toEqual([]);
  // The page is still the page, and back at the top its bar leaves the name to the heading in view.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('#pb-main main h1')).toBeVisible();
  await expect(bar.locator('.pb-vh__title')).toHaveAttribute('data-quiet', /.*/);
});
