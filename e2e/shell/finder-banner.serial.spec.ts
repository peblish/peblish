import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { readSetting } from '../../packages/core/src/settings/read.ts';
import { seedSetting } from '../../packages/core/src/testing/seed-a.ts';
import { defaultBanner, type SiteBanner } from '../../packages/schema/src/banner.ts';
import type { SiteWidth } from '../../packages/schema/src/site-settings.ts';
import { landed, signIn } from '../auth/support.ts';
import { choose, communityField } from '../composer/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The finder (shell/finder/) beside the site banner and the width preset (shell/banner.tsx, site-look.ts): on a phone
// the finder opens under the top bar with the banner under that bar, and nothing hides its field; a banner rechecked
// for the same viewer starts neither an open finder nor Create post's community field over; and the width presets
// leave the finder's desktop place centred. It saves the banner, the width and the brand pack, which every page
// reads, so it is a serial spec, and it puts them back after.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database to set site.banner, site.width and site.brand (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

const root = join(import.meta.dirname, '../..');
type Cast = { password: string; person: string; word: string; communities: Record<'bake', { handle: string }> };

const banner = (revision: number, title: string): SiteBanner => ({
  ...defaultBanner,
  enabled: true,
  revision,
  title,
  message: 'Posting pauses for an hour on Sunday. Reading works.',
  tone: 'accent',
  link: { label: 'Rules', href: '/rules' },
});

let cast: Cast;
let saved: { banner: SiteBanner; width: SiteWidth; brand: string } | undefined;
let member: BrowserContext;

test.beforeAll(async ({ browser, baseURL }) => {
  saved = { banner: await readSetting('site.banner'), width: await readSetting('site.width'), brand: await readSetting('site.brand') };
  cast = JSON.parse(execFileSync('node', ['e2e/shell/finder-seed.ts'], { cwd: root, encoding: 'utf8' }));
  member = await signedIn(browser, baseURL!);
});
test.afterAll(async () => {
  await member?.close();
  if (saved) {
    await seedSetting('site.banner', saved.banner);
    await seedSetting('site.width', saved.width);
    await seedSetting('site.brand', saved.brand);
  }
  await closePools();
});

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

const finder = (page: Page) => page.getByRole('dialog', { name: 'Find a community' });
const field = (page: Page) => finder(page).getByRole('searchbox', { name: 'Find a community' });
const joined = (page: Page) => finder(page).getByRole('group', { name: 'Joined' }).getByRole('option');

/** Whether the element drawn at the middle of `locator` is it or inside it: nothing covers it there. */
const onTop = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit !== null && (hit === element || element.contains(hit));
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

for (const pack of ['', 'feddit'])
  for (const width of [320, 390])
    test(`at ${width}px${pack ? ' with the feddit pack' : ''} the finder opens under the top bar, over the banner under it, its field uncovered`, async () => {
      await seedSetting('site.brand', pack);
      await seedSetting('site.width', 'default');
      const page = await member.newPage();
      await page.setViewportSize({ width, height: 800 });
      for (const shown of [false, true]) {
        await seedSetting('site.banner', shown ? banner(40 + width, 'Read-only window') : { ...defaultBanner, enabled: false });
        await gotoHydrated(page, '/');
        const bar = page.getByRole('navigation', { name: 'Page' });
        const box = (await bar.boundingBox())!;
        const strip = page.locator('.pb-app__banner--view');
        await expect(strip).toHaveCount(shown ? 1 : 0);
        if (shown) {
          await expect(strip).toBeVisible();
          // The banner follows the bar, as the mock has it.
          expect((await strip.boundingBox())!.y).toBeGreaterThanOrEqual(box.y + box.height - 1);
        }
        await bar.getByRole('link', { name: 'Find a community' }).click();
        await expect(field(page)).toBeFocused();
        await page.keyboard.type(cast.word);
        await expect(joined(page)).toHaveCount(2);
        const popup = (await finder(page).boundingBox())!;
        const at = `banner ${shown}`;
        expect(Math.abs(popup.y - (box.y + box.height)), at).toBeLessThanOrEqual(1);
        expect(popup.x, at).toBeLessThanOrEqual(1);
        expect(popup.width, at).toBeGreaterThanOrEqual(width - 1);
        // Neither the bar nor the banner is drawn over the field or the first row.
        expect(await onTop(field(page)), at).toBe(true);
        expect(await onTop(joined(page).first()), at).toBe(true);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect(finder(page)).toHaveCount(0);
      }
      await page.close();
    });

test('at Narrow, Default and Wide the finder stays in the middle of the window on a computer', async () => {
  await seedSetting('site.brand', '');
  await seedSetting('site.banner', banner(90, 'Read-only window'));
  const page = await member.newPage();
  for (const preset of ['narrow', 'default', 'wide'] as const) {
    await seedSetting('site.width', preset);
    await gotoHydrated(page, '/');
    await expect(page.locator('.pb-app')).toHaveAttribute('data-width', preset);
    await page.getByRole('banner').getByRole('link', { name: 'Find a community' }).click();
    await expect(field(page)).toBeFocused();
    const popup = (await finder(page).boundingBox())!;
    expect(Math.abs(popup.x + popup.width / 2 - 720), preset).toBeLessThanOrEqual(1);
    expect(await onTop(field(page)), preset).toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(finder(page)).toHaveCount(0);
  }
  await page.close();
});

test('a banner rechecked for the same viewer keeps an open finder’s text and Create post’s chosen community', async () => {
  await seedSetting('site.brand', '');
  await seedSetting('site.width', 'default');
  await seedSetting('site.banner', banner(100, 'First notice'));
  const page = await member.newPage();
  await page.clock.install();
  const strip = page.locator('.pb-app__banner:not(.pb-app__banner--view)');
  /** Publishes `title` and brings the tab back after the recheck's five minutes, so the shell asks again. */
  async function recheck(revision: number, title: string) {
    await seedSetting('site.banner', banner(revision, title));
    await page.clock.fastForward('05:01');
    const asked = page.waitForResponse((response) => response.url().includes('/_serverFn/'));
    await showAgain(page);
    await asked;
    await expect(strip).toContainText(title);
  }

  await gotoHydrated(page, '/');
  await expect(strip).toContainText('First notice');
  await page.getByRole('banner').getByRole('link', { name: 'Find a community' }).click();
  await expect(field(page)).toBeFocused();
  await page.keyboard.type(cast.word);
  await expect(joined(page)).toHaveCount(2);
  await recheck(101, 'Second notice');
  await expect(field(page)).toHaveValue(cast.word);
  await expect(field(page)).toBeFocused();
  await expect(joined(page)).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await gotoHydrated(page, '/submit');
  await choose(page, cast.communities.bake.handle);
  const chosen = await communityField(page).inputValue();
  const posted = await page.locator('form input[name="community"]').inputValue();
  await recheck(102, 'Third notice');
  await expect(communityField(page)).toHaveValue(chosen);
  await expect(page.locator('form input[name="community"]')).toHaveValue(posted);
  await page.close();
});
