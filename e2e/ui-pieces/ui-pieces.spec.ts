import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { prefsCookie } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The six shared pieces (packages/ui/src/components: Badge, Notice, LinkTabs, Pager, FactList,
// EmptyState) on the pages that render them, at a phone and a desktop width in both schemes: no
// sideways page scroll, a current tab that looks different from its siblings, Badge text that
// meets 4.5:1 on its own fill, long translated labels that wrap instead of overflowing, and a
// current tab that stays marked in forced colours (Windows high contrast). Screenshots go to
// UI_PIECES_SHOTS when it is set, else to e2e/artifacts/ui-pieces.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

type Seed = { owner: { name: string }; bot: { handle: string } };

let seed: Seed;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-e1.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
});

const shots = process.env.UI_PIECES_SHOTS ?? join(import.meta.dirname, '../artifacts/ui-pieces');
mkdirSync(shots, { recursive: true });

const widths = [320, 1280] as const;
const schemes = ['light', 'dark'] as const;
const tones = ['neutral', 'brand', 'success', 'warning', 'danger', 'admin', 'moderator', 'op', 'bot'] as const;
/** A label as long as a German translation can get, with a word too long for a phone line. */
const longLabel = 'Beiträge und Kommentare der abonnierten Gemeinschaften Gemeinschaftsmoderationsprotokolleinträge';

/** Each page and the pieces it shows (signed out, so no sign-in budget is spent). */
const pages = () => [
  { name: 'profile', path: `/u/${seed.owner.name}`, pieces: ['.pb-link-tabs', '.pb-facts'] },
  { name: 'bot', path: `/u/${seed.bot.handle}`, pieces: ['.pb-badge', '.pb-facts'] },
  // A search that matches nothing on page 2: segment tabs, the empty state and a pager with Previous.
  { name: 'directory', path: '/communities?q=zzqq-no-such-community&page=2', pieces: ['.pb-link-tabs', '.pb-empty-state', '.pb-pager'] },
  { name: 'sign-in-refused', path: '/auth/sign-in?error=credentials.invalid', pieces: ['.pb-alert'] },
];

async function open(browser: Browser, path: string, width: number, scheme: 'light' | 'dark', options: { forcedColors?: 'active' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, ...options });
  const page = await context.newPage();
  await context.addCookies([{ ...prefsCookie('card', scheme), url: test.info().project.use.baseURL! }]);
  await gotoHydrated(page, path);
  return { context, page };
}

/** How far the page scrolls sideways (0 when it does not). */
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** The computed properties that tell a tab apart, for the current tab and for each sibling. */
function tabLooks(page: Page, nav: string) {
  return page.locator(nav).evaluate((root) => {
    const look = (element: Element) => {
      const style = getComputedStyle(element);
      return [
        style.color,
        style.backgroundColor,
        style.borderBlockEndWidth,
        style.borderBlockEndColor,
        style.borderBlockStartWidth,
        style.textDecorationLine,
        style.outlineStyle,
        style.fontWeight,
      ].join('|');
    };
    const tabs = [...root.querySelectorAll('.muxui-tabs__tab')];
    const current = tabs.find((tab) => tab.getAttribute('aria-current') === 'page');
    return { current: current ? look(current) : null, others: tabs.filter((tab) => tab !== current).map(look) };
  });
}

/**
 * Text contrast of every badge on the page against its own fill (composited over whatever is
 * behind it when the fill is translucent). Colours are read through a canvas, so any colour space
 * the browser computes (oklch, color-mix) comes back as sRGB.
 */
function badgeContrasts(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (colour: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = 'black';
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
    const over = (top: number[], bottom: number[]) => top.slice(0, 3).map((value, i) => value * top[3]! + bottom[i]! * (1 - top[3]!));
    /** The opaque colour behind an element: its own background over its ancestors'. */
    const behind = (element: Element | null): number[] => {
      if (!element) return [255, 255, 255, 1];
      const own = rgba(getComputedStyle(element).backgroundColor);
      return own[3] >= 1 ? own : [...over(own, behind(element.parentElement)), 1];
    };
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((value) => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    return [...document.querySelectorAll('.pb-badge')].map((badge) => {
      const fill = behind(badge);
      const text = over(rgba(getComputedStyle(badge).color), fill);
      const [light, dark] = [luminance(text), luminance(fill)].sort((a, b) => b - a);
      return { badge: badge.className, ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100 };
    });
  });
}

/** Adds one badge of every tone to the page, so each tone is measured on the real stylesheet. */
function addEveryTone(page: Page) {
  return page.evaluate((all) => {
    const row = document.createElement('p');
    row.dataset.testid = 'every-tone';
    for (const tone of all) {
      const badge = document.createElement('span');
      badge.className = `pb-badge pb-badge--${tone}`;
      badge.textContent = tone;
      row.append(badge, ' ');
    }
    document.querySelector('main')!.prepend(row);
  }, tones);
}

for (const scheme of schemes) {
  for (const width of widths) {
    test(`the pieces at ${width}px in ${scheme}: no sideways scroll, a distinct current tab, readable badges`, async ({ browser }) => {
      for (const { name, path, pieces } of pages()) {
        const { context, page } = await open(browser, path, width, scheme);
        await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme);
        for (const piece of pieces) await expect(page.locator(piece).first(), `${name} shows ${piece}`).toBeVisible();
        await addEveryTone(page);
        await page.screenshot({ path: join(shots, `${name}-${width}-${scheme}.png`), fullPage: true });

        expect(await sideways(page), `${name} scrolls sideways`).toBe(0);
        for (const nav of await page.locator('nav.pb-link-tabs').all()) {
          const label = await nav.getAttribute('aria-label');
          const looks = await tabLooks(page, `nav.pb-link-tabs[aria-label="${label}"]`);
          expect(looks.current, `${name}: ${label} has a current tab`).not.toBeNull();
          for (const other of looks.others) expect(other, `${name}: ${label}'s current tab looks like a sibling`).not.toBe(looks.current);
        }
        for (const { badge, ratio } of await badgeContrasts(page)) {
          expect(ratio, `${name}: ${badge} contrast in ${scheme}`).toBeGreaterThanOrEqual(4.5);
        }
        await context.close();
      }
    });
  }
}

test('a long translated tab label wraps inside a 320px screen, in both variants', async ({ browser }) => {
  for (const { path, nav } of [
    { path: `/u/${seed.owner.name}`, nav: 'nav.pb-link-tabs' },
    { path: '/communities', nav: 'nav.pb-link-tabs' },
  ]) {
    const { context, page } = await open(browser, path, 320, 'light');
    const tabs = page.locator(nav).first();
    await tabs
      .locator('.muxui-tabs__tab')
      .first()
      .evaluate((tab, label) => (tab.textContent = label), longLabel);
    await page.screenshot({ path: join(shots, `long-tab-${path === '/communities' ? 'segment' : 'underline'}-320.png`), fullPage: true });
    expect(await sideways(page), `${path} scrolls sideways`).toBe(0);
    const right = await tabs
      .locator('.muxui-tabs__tab')
      .first()
      .evaluate((tab) => tab.getBoundingClientRect().right);
    expect(right).toBeLessThanOrEqual(320);
    await context.close();
  }
});

test('the current tab stays marked in forced colours, in both variants', async ({ browser }) => {
  for (const { path, variant } of [
    { path: `/u/${seed.owner.name}`, variant: 'underline' },
    { path: '/communities', variant: 'segment' },
  ]) {
    const { context, page } = await open(browser, path, 1280, 'light', { forcedColors: 'active' });
    const nav = `nav.pb-link-tabs:has([data-muxui-tabs-variant="${variant}"])`;
    await page
      .locator(nav)
      .first()
      .screenshot({ path: join(shots, `forced-colours-${variant}.png`) });
    // Forced colours replace every colour and background, and the underline variant's border lies
    // on the list's own border, so the mark must be one that survives: an underline under the text.
    const marks = await page
      .locator(nav)
      .first()
      .evaluate((root) =>
        [...root.querySelectorAll('.muxui-tabs__tab')].map((tab) => ({
          current: tab.getAttribute('aria-current') === 'page',
          underline: getComputedStyle(tab).textDecorationLine.includes('underline'),
        })),
      );
    expect(
      marks.filter((mark) => mark.current),
      `${variant} has one current tab`,
    ).toHaveLength(1);
    for (const mark of marks) expect(mark.underline, `${variant}: only the current tab is underlined`).toBe(mark.current);
    await context.close();
  }
});

test('a long translated fact label leaves room for its value, in both layouts', async ({ browser }) => {
  for (const width of widths) {
    const { context, page } = await open(browser, `/u/${seed.owner.name}`, width, 'light');
    // The profile's list uses the rows layout; a copy of it in the inline layout covers the other one.
    await expect(page.locator('dl.pb-facts--rows')).toHaveCount(1);
    await page
      .locator('dl.pb-facts')
      .first()
      .evaluate((list, label) => {
        list.querySelector('dt')!.textContent = label;
        const inline = list.cloneNode(true) as HTMLElement;
        inline.classList.replace('pb-facts--rows', 'pb-facts--inline');
        list.after(inline);
      }, longLabel);
    await expect(page.locator('dl.pb-facts--inline')).toHaveCount(1);
    await page.screenshot({ path: join(shots, `long-fact-${width}.png`), fullPage: true });
    expect(await sideways(page)).toBe(0);
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll('dl.pb-facts')].slice(0, 2).map((list) => ({
        list: list.getBoundingClientRect(),
        dt: list.querySelector('dt')!.getBoundingClientRect(),
        dd: list.querySelector('dd')!.getBoundingClientRect(),
        /** The heights of the short labels after the long one ("Posts", "Comments"). */
        short: [...list.querySelectorAll('dt')].slice(1).map((dt) => dt.getBoundingClientRect().height),
      })),
    );
    for (const { list, dt, dd, short } of sizes) {
      // A short label never breaks inside its word: every one is a single line, as tall as the first.
      for (const height of short) expect(height, 'a short label stays on one line').toBeCloseTo(short[0]!, 0);
      expect(dt.right, 'the label stays inside the list').toBeLessThanOrEqual(list.right + 0.5);
      expect(dd.right, 'the value stays inside the list').toBeLessThanOrEqual(list.right + 0.5);
      // The value keeps at least 40% of the list (rows: the label column is at most 40% or 8em, so
      // a narrow card leaves a little less than 60%), or sits below its label (inline).
      expect(dd.width >= list.width * 0.4 || dd.top >= dt.bottom, 'the value keeps its room').toBe(true);
    }
    await context.close();
  }
});
