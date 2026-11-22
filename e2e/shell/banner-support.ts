import type { Browser, Locator, Page } from '@playwright/test';
import { colours } from '../support/contrast.ts';
import { prefsCookie } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// Helpers of the banner's gallery specs (banner-states.spec.ts, banner-packs.serial.spec.ts).

export async function open(browser: Browser, baseURL: string, path: string, scheme: 'light' | 'dark', options = {}) {
  const context = await browser.newContext({ baseURL, colorScheme: scheme, viewport: { width: 1280, height: 900 }, ...options });
  await context.addCookies([{ ...prefsCookie('card', scheme), url: baseURL }]);
  const page = await context.newPage();
  await gotoHydrated(page, path);
  return page;
}

/** Waits for every transition to end, so a state is measured once it is reached. */
export const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished),
    ),
  );

/** What `part` paints in each state of `control`: rest, hovered, pressed (released away, so nothing is activated). */
export async function inStates(page: Page, control: Locator, part: Locator, kind: 'text' | 'icon') {
  const measured: Record<string, number> = {};
  await page.mouse.move(0, 0);
  await settled(page);
  measured.rest = (await colours(part))[kind]!.ratio;
  await control.hover();
  await settled(page);
  measured.hover = (await colours(part))[kind]!.ratio;
  await page.mouse.down();
  await settled(page);
  measured.pressed = (await colours(part))[kind]!.ratio;
  await page.mouse.move(0, 0);
  await page.mouse.up();
  return measured;
}
