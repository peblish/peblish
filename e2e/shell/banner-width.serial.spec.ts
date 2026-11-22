import { expect, test, type Browser } from '@playwright/test';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { readSetting } from '../../packages/core/src/settings/read.ts';
import { seedSetting } from '../../packages/core/src/testing/seed-a.ts';
import { defaultBanner, type SiteBanner } from '../../packages/schema/src/banner.ts';
import type { SiteWidth } from '../../packages/schema/src/site-settings.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The site banner's slot and the width preset in the frame (shell.tsx, banner.tsx, shell.css), set straight in the
// lane database: the banner in the same place with scripts off and on, so hydration moves nothing; on a phone at
// the top of the page with 44px controls; and the three widths at 1440, 1100 and 390. It saves settings every page
// reads, so it is a serial spec, and it puts them back after.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database to set site.banner and site.width (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let saved: { banner: SiteBanner; width: SiteWidth } | undefined;
const banner: SiteBanner = {
  ...defaultBanner,
  enabled: true,
  revision: 7,
  title: 'Read-only window',
  message: 'Posting pauses for an hour on Sunday while the database moves. Reading works.',
  icon: 'wrench',
  tone: 'accent',
  primary: { label: 'Details', href: '/about' },
  link: { label: 'Rules', href: '/rules' },
};
test.beforeAll(async () => {
  saved = { banner: await readSetting('site.banner'), width: await readSetting('site.width') };
  await seedSetting('site.banner', banner);
  await seedSetting('site.width', 'default');
});
test.afterAll(async () => {
  if (saved) {
    await seedSetting('site.banner', saved.banner);
    await seedSetting('site.width', saved.width);
  }
  await closePools();
});

/**
 * The banner's box and the page's top, once hydrated (`hydrated`) or as the server sent them: scripts on, so the
 * page is drawn as for a browser that runs them, but none loaded, so it never hydrates.
 */
async function layout(browser: Browser, baseURL: string, width: number, hydrated: boolean, dismissed?: number) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
  await context.addCookies([{ name: 'peblish_side', value: 'rail', url: baseURL }]);
  if (dismissed !== undefined) await context.addCookies([{ name: 'peblish_banner', value: String(dismissed), url: baseURL }]);
  const page = await context.newPage();
  if (hydrated) await gotoHydrated(page, '/');
  else {
    await page.route('**/*', (route) => (route.request().resourceType() === 'script' ? route.abort() : route.continue()));
    await page.goto('/', { waitUntil: 'load' });
  }
  const measured = await page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? [rect.x, rect.y, rect.width, rect.height].map(Math.round) : null;
    };
    // The page's place, not its height, which its own content sets once hydrated.
    const shown = [...document.querySelectorAll('.pb-app__banner')].find((banner) => banner.getBoundingClientRect().height > 0);
    const banner = shown ? shown.getBoundingClientRect() : null;
    return {
      banner: banner ? [banner.x, banner.y, banner.width, banner.height].map(Math.round) : null,
      main: box('#pb-main')!.slice(0, 3),
    };
  });
  await context.close();
  return measured;
}

test('the banner sits where the server put it: the same box before and after hydration, dismissed or not', async ({ browser, baseURL }) => {
  for (const width of [1440, 390]) {
    const shown = await layout(browser, baseURL!, width, true);
    expect(shown.banner, `${width}`).not.toBeNull();
    expect(shown, `${width}`).toEqual(await layout(browser, baseURL!, width, false));
    // An older dismissal leaves this revision shown; this one's leaves it out, on the server too.
    expect((await layout(browser, baseURL!, width, true, 6)).banner).toEqual(shown.banner);
    const gone = await layout(browser, baseURL!, width, true, 7);
    expect(gone.banner).toBeNull();
    expect(gone).toEqual(await layout(browser, baseURL!, width, false, 7));
  }
});

test('a banner that is off sends nothing of itself to any page, signed out included', async ({ request }) => {
  await seedSetting('site.banner', {
    ...banner,
    enabled: false,
    title: 'Draft title',
    message: 'Draft only, not for readers.',
    primary: { label: 'Draft go', href: '/draft-target' },
  });
  for (const path of ['/', '/communities', '/about']) {
    const html = await (await request.get(path)).text();
    for (const draft of ['Draft only, not for readers.', 'Draft title', 'Draft go', '/draft-target', 'aria-label="Site notice"'])
      expect(html, `${path} ${draft}`).not.toContain(draft);
  }
  // On again: shown, as before.
  await seedSetting('site.banner', banner);
  expect(await (await request.get('/')).text()).toContain('Posting pauses for an hour on Sunday');
});

test('a tab that comes back after five minutes takes a new banner and width; one that comes back sooner keeps its own', async ({
  page,
}) => {
  await seedSetting('site.banner', banner);
  await seedSetting('site.width', 'default');
  await page.clock.install();
  await gotoHydrated(page, '/');
  const region = page.getByRole('region', { name: 'Site notice' });
  await expect(region).toContainText('Posting pauses for an hour');
  await seedSetting('site.banner', { ...banner, revision: 8, message: 'Posting is back.' });
  await seedSetting('site.width', 'wide');
  const back = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // Sooner: nothing is asked.
  await page.clock.fastForward('02:00');
  await back();
  await page.waitForTimeout(500);
  await expect(region).toContainText('Posting pauses for an hour');
  await expect(page.locator('.pb-app')).toHaveAttribute('data-width', 'default');
  await page.clock.fastForward('04:00');
  await back();
  await expect(region).toContainText('Posting is back.');
  await expect(page.locator('.pb-app')).toHaveAttribute('data-width', 'wide');
  // Turned off meanwhile: it goes.
  await seedSetting('site.banner', { ...banner, enabled: false, revision: 9 });
  await page.clock.fastForward('06:00');
  await back();
  await expect(page.locator('.pb-app__banner')).toHaveCount(0);
  await seedSetting('site.banner', banner);
  await seedSetting('site.width', 'default');
});

test('on a phone the banner sits under the top bar, after it in focus order, on a feed and on a page with its own bar; each control 44px', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  for (const path of ['/', '/communities', '/about']) {
    await gotoHydrated(page, path);
    // One banner on a phone, as on a computer: the other place's is not drawn.
    const region = page.getByRole('region', { name: 'Site notice' });
    await expect(region, path).toHaveCount(1);
    const bar = page.locator('.pb-frame-vh').first();
    const [barBox, box] = [(await bar.boundingBox())!, (await region.boundingBox())!];
    // Under the bar: flush, or a page's own gap below it where the page draws its own bar among its spaced parts.
    expect(box.y, path).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
    expect(box.y - (barBox.y + barBox.height), path).toBeLessThanOrEqual(32);
    // Nothing between them: the banner is the bar's next element.
    expect(await bar.evaluate((node) => node.nextElementSibling?.matches('.pb-app__banner--view')), path).toBe(true);
    expect(Math.round(box.width), path).toBe(390);
    // In the document, so in focus order, the bar comes first.
    expect(
      await bar.evaluate(
        (node, banner) => Boolean(node.compareDocumentPosition(banner!) & Node.DOCUMENT_POSITION_FOLLOWING),
        await region.elementHandle(),
      ),
      path,
    ).toBe(true);
  }
  await gotoHydrated(page, '/');
  const region = page.getByRole('region', { name: 'Site notice' });
  for (const control of [
    region.getByRole('link', { name: 'Details' }),
    region.getByRole('link', { name: 'Rules' }),
    region.getByRole('button', { name: 'Dismiss notice' }),
  ]) {
    const box = (await control.boundingBox())!;
    expect(Math.min(box.width, box.height), await control.textContent()).toBeGreaterThanOrEqual(44);
  }
  // The bar sticks at the top as the banner scrolls away under it.
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await page.locator('.pb-frame-vh').first().boundingBox())!.y).toBe(0);
  // Dismissed in one place, it is gone from both.
  await gotoHydrated(page, '/');
  await page.getByRole('region', { name: 'Site notice' }).getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(page.locator('.pb-app__banner')).toHaveCount(0);
  await context.close();
});

/** The frame's width, the rail's and a post's text at a window width (the sidebar folded to its rail). */
async function frame(browser: Browser, baseURL: string, path: string, width: number) {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
  await context.addCookies([{ name: 'peblish_side', value: 'rail', url: baseURL }]);
  const view = await context.newPage();
  await gotoHydrated(view, path);
  const measured = await view.evaluate(() => {
    const width = (selector: string) => Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? 0);
    return {
      frame: width('#pb-main'),
      rail: width('.pb-rail'),
      prose: width('.pb-prose'),
      preset: document.querySelector('.pb-app')!.getAttribute('data-width'),
    };
  });
  await context.close();
  return measured;
}

test('the three widths at 1440, 1100 and 390: the frame and the rail, and text kept at its measure', async ({
  browser,
  baseURL,
  request,
}) => {
  // A post on the lane database whose page has body text.
  const html = await (await request.get('/all')).text();
  let withProse = '';
  for (const [, path] of html.matchAll(/href="(\/post\/[^"/]+)"/g))
    if ((await (await request.get(path!)).text()).includes('pb-prose')) {
      withProse = path!;
      break;
    }
  expect(withProse).not.toBe('');
  // Frame widths include the frame's own hairline; the rail keeps its 312px and gives way on a phone. With the
  // sidebar folded, 1100 leaves Wide less than its 1112.
  const expected: Record<SiteWidth, number[]> = { narrow: [873, 873, 390], default: [953, 953, 390], wide: [1113, 1006, 390] };
  for (const width of ['narrow', 'default', 'wide'] as const) {
    await seedSetting('site.width', width);
    const sizes = [];
    for (const window of [1440, 1100, 390]) sizes.push(await frame(browser, baseURL!, '/', window));
    expect(sizes.map(({ preset }) => preset)).toEqual([width, width, width]);
    expect(
      sizes.map(({ frame }) => frame),
      width,
    ).toEqual(expected[width]);
    expect(
      sizes.map(({ rail }) => rail),
      width,
    ).toEqual([312, 312, 0]);
    // A post's text keeps Default's 600px measure at Wide; Narrow's column is narrower than that.
    expect((await frame(browser, baseURL!, withProse, 1440)).prose, width).toBe(width === 'narrow' ? 520 : 600);
  }
});
