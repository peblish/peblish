import { expect, test } from '@playwright/test';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { readSetting } from '../../packages/core/src/settings/read.ts';
import { seedSetting } from '../../packages/core/src/testing/seed-a.ts';
import type { SiteBrand } from '../../packages/schema/src/site-settings.ts';
import { colours } from '../support/contrast.ts';
import { skipWithoutKit } from '../support/kit.ts';
import { inStates, open, settled } from './banner-support.ts';

// Every banner control on every tone (/kit/site-banner-tones), with no brand pack and with the feddit pack: the text
// at 4.5:1 and the dismiss icon at 3:1 at rest, hovered and pressed, and the keyboard focus ring at 3:1 against the
// banner, in light and dark. It sets site.brand, which every page reads, so it is a serial spec, and puts it back.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database to set site.brand (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(300_000);

let saved: SiteBrand | undefined;
test.beforeAll(async () => {
  saved = await readSetting('site.brand');
});
test.afterAll(async () => {
  if (saved !== undefined) await seedSetting('site.brand', saved);
  await closePools();
});

for (const pack of ['', 'feddit'] as const) {
  const named = pack || 'no pack';
  test(`${named}: every tone in both emphases: the text at 4.5:1 and the dismiss icon at 3:1, at rest, hovered and pressed, light and dark`, async ({
    browser,
    baseURL,
  }) => {
    await seedSetting('site.brand', pack);
    const problems: string[] = [];
    for (const scheme of ['light', 'dark'] as const) {
      const page = await open(browser, baseURL!, '/kit/site-banner-tones', scheme);
      const banners = page.locator('[data-kit-banner]');
      expect(await banners.count()).toBe(14);
      for (const banner of await banners.all()) {
        const name = `${scheme} ${await banner.getAttribute('data-kit-banner')}`;
        for (const part of ['.muxui-banner__message', '.muxui-banner__title']) {
          if (!(await banner.locator(part).count())) continue;
          const ratio = (await colours(banner.locator(part)))[`text`]!.ratio;
          if (ratio < 4.5) problems.push(`${name} ${part} ${ratio}`);
        }
        const button = banner.locator('.muxui-banner__action');
        const link = banner.locator('.muxui-banner__link');
        const dismiss = banner.locator('.muxui-banner__dismiss');
        for (const [control, part, kind, floor] of [
          [button, button.locator('.muxui-button__label'), 'text', 4.5],
          [link, link, 'text', 4.5],
          [dismiss, dismiss, 'icon', 3],
        ] as const)
          for (const [state, ratio] of Object.entries(await inStates(page, control, part, kind)))
            if (ratio < floor) problems.push(`${name} ${await control.getAttribute('class')} ${state} ${ratio}`);
      }
      await page.context().close();
    }
    expect(problems).toEqual([]);
  });

  test(`${named}: focused from the keyboard, every control on every banner has a ring at 3:1 against the banner, light and dark`, async ({
    browser,
    baseURL,
  }) => {
    await seedSetting('site.brand', pack);
    const problems: string[] = [];
    for (const scheme of ['light', 'dark'] as const) {
      const page = await open(browser, baseURL!, '/kit/site-banner-tones', scheme);
      for (const banner of await page.locator('[data-kit-banner]').all()) {
        const name = `${scheme} ${await banner.getAttribute('data-kit-banner')}`;
        for (const control of [
          banner.locator('.muxui-banner__action'),
          banner.locator('.muxui-banner__link'),
          banner.locator('.muxui-banner__dismiss'),
        ]) {
          // A key first, so the browser and React Aria count the focus as the keyboard's.
          await page.keyboard.press('Shift+Tab');
          await control.focus();
          await settled(page);
          const ring = (await colours(control)).outline;
          if (!ring || ring.ratio < 3) problems.push(`${name} ${await control.getAttribute('class')}: ${ring?.ratio ?? 'none'}`);
        }
      }
      await page.context().close();
    }
    expect(problems).toEqual([]);
  });
}
