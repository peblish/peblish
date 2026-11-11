import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// Text contrast in the sidebar and the top bar, in each scheme chosen through the Appearance
// control as a person does (not by setting the attribute). The top bar is an inverse bar, dark
// in both schemes by design. Text needs 4.5:1 (WCAG AA), the nav icons 3:1 (non-text).
test.use({ viewport: { width: 1280, height: 800 } });

/**
 * The contrast of an element's text colour against what is painted behind it: every ancestor's
 * background colour composited in a 1 px canvas (so alpha and any CSS colour syntax resolve as
 * the browser paints them), then the text colour over that.
 */
const contrast = (target: Locator) =>
  target.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const pixel = () => Array.from(context.getImageData(0, 0, 1, 1).data.subarray(0, 3));
    const paint = (colour: string) => {
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
    };
    const chain: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node);
    paint('white');
    for (const node of chain) paint(getComputedStyle(node).backgroundColor);
    const back = pixel();
    paint(getComputedStyle(element).color);
    const fore = pixel();
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [light, dark] = [luminance(fore), luminance(back)].sort((a, b) => b - a);
    return Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100;
  });

async function choose(page: Page, scheme: 'Light' | 'Dark') {
  await page.getByRole('banner').getByRole('button', { name: 'Appearance' }).click();
  await page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: scheme }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-muxui-color-scheme', scheme.toLowerCase());
  // Mux eases link colours: measure once every transition has ended (or was cancelled).
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)));
}

/** Each sample's contrast, printed so the numbers are in the run's log. */
async function measure(page: Page, label: string, samples: Record<string, Locator>, minimum: Record<string, number> = {}) {
  for (const [name, target] of Object.entries(samples)) {
    const ratio = await contrast(target);
    console.log(`contrast ${label} ${name}: ${ratio}`);
    expect(ratio, `${label} ${name}`).toBeGreaterThanOrEqual(minimum[name] ?? 4.5);
  }
}

const sidebar = (page: Page) => {
  const side = page.getByRole('complementary', { name: 'Sidebar' });
  const feeds = side.getByRole('navigation', { name: 'Feeds' });
  return {
    'sidebar link': feeds.getByRole('link', { name: 'Local' }).locator('.muxui-sidebar__nav-label'),
    'sidebar current item': feeds.getByRole('link', { name: 'All', exact: true }).locator('.muxui-sidebar__nav-label'),
    'sidebar section label': side.locator('.muxui-sidebar__section-label').first(),
    'sidebar footer link': side.getByRole('navigation', { name: 'About this site' }).getByRole('link', { name: 'Rules' }),
    'sidebar icon': feeds.getByRole('link', { name: 'Local' }).locator('svg'),
  };
};

for (const scheme of ['Light', 'Dark'] as const) {
  test(`in ${scheme}, chosen through Appearance, the sidebar and the top bar text reach 4.5:1`, async ({ page, browser }) => {
    await gotoHydrated(page, '/all');
    await choose(page, scheme);
    const feeds = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('navigation', { name: 'Feeds' });
    await expect(feeds.getByRole('link', { name: 'All', exact: true })).toHaveAttribute('aria-current', 'page');
    const top = page.locator('.pb-top');
    await page.screenshot({ path: test.info().outputPath(`${scheme.toLowerCase()}.png`) });
    await measure(
      page,
      `${scheme} signed out`,
      {
        ...sidebar(page),
        'top bar Sign in': top.getByRole('link', { name: 'Sign in' }),
        'top bar Sign up': top.getByRole('link', { name: 'Sign up' }),
        'top bar Appearance': top.getByRole('button', { name: 'Appearance' }),
      },
      { 'sidebar icon': 3 },
    );

    test.skip(Boolean(process.env.BASE_URL), 'the signed-in half needs the lane database for its seed (DATABASE_URL)');
    const { password, people } = JSON.parse(
      execFileSync('node', ['e2e/shell/seed.ts'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
    ) as { password: string; people: [string, string] };
    const signedIn = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await gotoHydrated(signedIn, '/auth/sign-in');
    await signIn(signedIn, `@${people[0]}`, password);
    await landed(signedIn, '/');
    await choose(signedIn, scheme);
    const bar = signedIn.locator('.pb-top');
    await measure(signedIn, `${scheme} signed in`, {
      'top bar Create post': bar.getByRole('link', { name: 'Create post' }),
      'top bar account name': bar.locator('.pb-account__name'),
    });
    await signedIn.context().close();
  });
}
