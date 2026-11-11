import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { prefsCookie, skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// LinkTabs (links, for pages) draw what a Mux Tabs bar (buttons, for panels) draws: the gallery
// shows one of each, in both variants. Mux's hydrated Tabs paint the selected mark and the hover
// fill on moving layers; LinkTabs have no script, so Mux's own pre-hydration rules paint the mark
// on the tab, and hover is a plain fill on the tab.
test.beforeEach(({ request }) => skipWithoutKit(request));

const looks = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'padding-top',
  'padding-left',
  'min-width',
  'height',
  'border-top-left-radius',
  'text-decoration-line',
  'cursor',
];
const look = (tab: Locator) =>
  tab.evaluate((element, names) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
  }, looks);

/** The selected mark Mux draws: its size and colour, on the moving layer (Tabs) or the label's stand-in (LinkTabs). */
const mark = (root: Locator, variant: string) =>
  root.evaluate((element, variant) => {
    const moving = element.querySelector<HTMLElement>('.muxui-tabs__motion-underline');
    const tab = element.querySelector('.muxui-tabs__tab[data-muxui-state-selected], .muxui-tabs__tab[aria-selected="true"]')!;
    const box = (target: Element) => {
      const { width, height } = target.getBoundingClientRect();
      return { width: Math.round(width), height: Math.round(height) };
    };
    if (moving && getComputedStyle(moving).opacity === '1') return { ...box(moving), fill: getComputedStyle(moving).backgroundColor };
    if (variant === 'underline') {
      const label = tab.querySelector('.muxui-tabs__tab-label')!;
      const after = getComputedStyle(label, '::after');
      return { width: Math.round(parseFloat(after.width)), height: Math.round(parseFloat(after.height)), fill: after.backgroundColor };
    }
    return { ...box(tab), fill: getComputedStyle(tab).backgroundColor };
  }, variant);

async function settle(page: Page) {
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)));
}

for (const scheme of ['light', 'dark'] as const) {
  test(`LinkTabs look like Mux Tabs at rest and when focused, and fill on hover (${scheme})`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ ...prefsCookie('card', scheme), url: baseURL! }]);
    await gotoHydrated(page, '/kit');
    for (const variant of ['underline', 'segment'] as const) {
      const row = page.getByTestId(`kit-tabs-${variant}`);
      await row.screenshot({ path: test.info().outputPath(`${variant}-${scheme}.png`) });
      const tabs = row.getByRole('tablist').getByRole('tab');
      const links = row.getByRole('navigation').getByRole('link');
      await expect(links.first()).toHaveAttribute('aria-current', 'page');
      await page.mouse.move(0, 0);
      await settle(page);
      // The selected tab's text colour on a filled variant comes from Mux's foreground layer, so compare the rest.
      const { color: _selectedColour, ...selected } = await look(tabs.first());
      const { color: _linkColour, ...linkSelected } = await look(links.first());
      expect(linkSelected, `${variant}: the selected tab`).toEqual(selected);
      expect(await look(links.nth(1)), `${variant}: an unselected tab`).toEqual(await look(tabs.nth(1)));
      expect(await mark(row.getByRole('navigation'), variant), `${variant}: the selected mark`).toEqual(
        await mark(row.locator('.muxui-tabs').first(), variant),
      );

      // Keyboard focus: Tab reaches the selected Mux tab, an arrow key the next (manual activation); Tab reaches each link.
      const ring = (tab: Locator) =>
        tab.evaluate((element) => [getComputedStyle(element).boxShadow, getComputedStyle(element).outlineStyle]);
      await tabs.first().focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toBeFocused();
      await settle(page);
      const muxRing = await ring(tabs.nth(1));
      await links.nth(1).focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(links.nth(1)).toBeFocused();
      await settle(page);
      expect(await ring(links.nth(1)), `${variant}: a focused unselected tab`).toEqual(muxRing);
      expect(muxRing, `${variant}: focus draws a ring`).not.toEqual(['none', 'none']);

      await links.nth(1).hover();
      await settle(page);
      expect(await links.nth(1).evaluate((element) => getComputedStyle(element).backgroundColor), `${variant}: hover fills`).not.toBe(
        'rgba(0, 0, 0, 0)',
      );
      expect((await look(links.nth(1))).color, `${variant}: hover keeps the tab colour`).toBe((await look(tabs.nth(2))).color);
      await page.locator('body').click({ position: { x: 1, y: 1 } });
    }
  });
}

const variants = ['underline', 'segment'] as const;

/**
 * A kit page in its own context: a scheme, and optionally scripts off or forced colours. The system
 * takes the scheme too, which picks the light or dark forced palette.
 */
async function kit(
  browser: Browser,
  baseURL: string,
  scheme: 'light' | 'dark',
  options: { javaScriptEnabled?: boolean; forcedColors?: 'active' } = {},
) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, ...options });
  await context.addCookies([{ ...prefsCookie('card', scheme), url: baseURL }]);
  const page = await context.newPage();
  if (options.javaScriptEnabled === false) await page.goto('/kit');
  else await gotoHydrated(page, '/kit');
  return page;
}
const linksOf = (page: Page, variant: string) => page.getByTestId(`kit-tabs-${variant}`).getByRole('navigation').getByRole('link');

/** What draws a focus ring on a tab: its outline and its shadow. */
const ringOf = (tab: Locator) =>
  tab.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}`, shadow: style.boxShadow };
  });

/** Focuses a tab from the keyboard (Tab from the element before it), so it matches :focus-visible. */
async function keyboardFocus(page: Page, tab: Locator) {
  await tab.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(tab).toBeFocused();
  await settle(page);
}

/** The contrast of a tab's outline colour against the page's background, both painted in a 1 px canvas. */
const outlineContrast = (tab: Locator) =>
  tab.evaluate((element) => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const painted = (colour: string) => {
      context.fillStyle = 'white';
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data.subarray(0, 3));
    };
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [light, dark] = [painted(getComputedStyle(element).outlineColor), painted(getComputedStyle(document.body).backgroundColor)]
      .map(luminance)
      .sort((a, b) => b - a);
    return Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100;
  });

/**
 * Colours as the browser paints them, composited in a 1 px canvas: the page's backgrounds from the
 * root down to the tab (with `under`, a layer Mux paints beneath the tab, just before it), the tab's
 * own background image when it is a plain colour gradient, and the tab's text over all of it.
 * Returns the background and text pixels and their contrast.
 */
const paintOf = async (tab: Locator, under?: Locator) =>
  tab.evaluate(
    (element, beneath) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      const pixel = () => Array.from(context.getImageData(0, 0, 1, 1).data.subarray(0, 3));
      const paint = (colour: string) => {
        context.fillStyle = colour;
        context.fillRect(0, 0, 1, 1);
      };
      const chain: Element[] = [];
      for (let node: Element | null = element.parentElement; node; node = node.parentElement) chain.unshift(node);
      paint('white');
      for (const node of chain) paint(getComputedStyle(node).backgroundColor);
      if (beneath) paint(getComputedStyle(beneath).backgroundColor);
      const style = getComputedStyle(element);
      paint(style.backgroundColor);
      const layer = /^linear-gradient\(((?:rgba?|color)\([^()]*\))/.exec(style.backgroundImage)?.[1];
      if (layer) paint(layer);
      const back = pixel();
      paint(style.color);
      const fore = pixel();
      const luminance = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const [light, dark] = [luminance(fore), luminance(back)].sort((a, b) => b - a);
      return { back, fore, contrast: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100 };
    },
    under ? await under.elementHandle() : null,
  );

// Keyboard focus rings every tab, the current one too, and the ring does not wait for scripts: with
// scripts on Mux marks a focused link itself, with scripts off (or a router link) only :focus-visible does.
for (const scheme of ['light', 'dark'] as const) {
  test(`keyboard focus rings every LinkTab, the same with scripts on and off (${scheme})`, async ({ browser, baseURL }) => {
    const pages = { on: await kit(browser, baseURL!, scheme), off: await kit(browser, baseURL!, scheme, { javaScriptEnabled: false }) };
    for (const variant of variants)
      for (const [which, index] of [
        ['current', 0],
        ['unselected', 1],
      ] as const) {
        const rings: Record<string, Awaited<ReturnType<typeof ringOf>>> = {};
        for (const [scripts, page] of Object.entries(pages)) {
          const tab = linksOf(page, variant).nth(index);
          const rest = await ringOf(tab);
          await keyboardFocus(page, tab);
          rings[scripts] = await ringOf(tab);
          const label = `${variant}, ${which} tab, scripts ${scripts}`;
          // A ring is a 2px outline, or a shadow the tab does not have at rest (the segment's resting elevation is not one).
          const outlined = !rings[scripts]!.outline.startsWith('none') && parseFloat(rings[scripts]!.outline.split(' ')[1]!) >= 2;
          expect(outlined || rings[scripts]!.shadow !== rest.shadow, `${label}: focus draws a ring`).toBe(true);
        }
        expect(rings.off, `${variant}, ${which} tab: the same ring without scripts`).toEqual(rings.on);
      }
    await Promise.all(Object.values(pages).map((page) => page.context().close()));
  });
}

// Forced colours drop every shadow, so a ring there must be an outline, in a system colour that stands
// out from the page: one colour on every tab, the one Mux Tabs outline an unselected tab with.
for (const javaScriptEnabled of [true, false]) {
  test(`in forced colours keyboard focus outlines every LinkTab (scripts ${javaScriptEnabled ? 'on' : 'off'})`, async ({
    browser,
    baseURL,
  }) => {
    const page = await kit(browser, baseURL!, 'light', { javaScriptEnabled, forcedColors: 'active' });
    const colours = new Set<string>();
    for (const variant of variants)
      for (const [which, index] of [
        ['current', 0],
        ['unselected', 1],
      ] as const) {
        const tab = linksOf(page, variant).nth(index);
        await keyboardFocus(page, tab);
        const { outline } = await ringOf(tab);
        const label = `${variant}, ${which} tab`;
        expect(outline, `${label}: a solid outline`).toMatch(/^solid 2px /);
        expect(await outlineContrast(tab), `${label}: the outline stands out from the page`).toBeGreaterThanOrEqual(3);
        colours.add(await tab.evaluate((element) => getComputedStyle(element).outlineColor));
        if (javaScriptEnabled && which === 'unselected') {
          // Mux Tabs outline an unselected focused tab the same way in forced colours.
          const muxTab = page.getByTestId(`kit-tabs-${variant}`).getByRole('tablist').getByRole('tab').nth(1);
          await keyboardFocus(page, page.getByTestId(`kit-tabs-${variant}`).getByRole('tablist').getByRole('tab').first());
          await page.keyboard.press('ArrowRight');
          await expect(muxTab).toBeFocused();
          expect(outline, `${label}: as Mux Tabs outline it`).toBe((await ringOf(muxTab)).outline);
        }
      }
    expect([...colours], 'one system colour for every focused tab').toHaveLength(1);
    await page.context().close();
  });
}

/**
 * Runs `check` with the current tab hovered, then pressed, then keyboard-focused, each on the kit page
 * opened afresh: releasing the press clicks the tab, which opens the kit again.
 */
async function inEachState(page: Page, tab: Locator, javaScriptEnabled: boolean, check: (state: string) => Promise<void>) {
  const states: Record<string, () => Promise<void>> = {
    hovered: async () => {
      await tab.hover();
      await settle(page);
    },
    pressed: async () => {
      await tab.hover();
      await page.mouse.down();
      await settle(page);
    },
    focused: async () => keyboardFocus(page, tab),
  };
  for (const [state, enter] of Object.entries(states)) {
    if (javaScriptEnabled) await gotoHydrated(page, '/kit');
    else await page.goto('/kit');
    await page.mouse.move(0, 0);
    await enter();
    await check(state);
    await page.mouse.up();
    // The release clicked the tab: let that navigation land before the next one starts.
    if (state === 'pressed') await page.waitForURL(/\/kit\?tab=/);
  }
}

const backgroundOf = (tab: Locator) => tab.evaluate((element) => getComputedStyle(element).backgroundColor);

// The current segment tab keeps its solid selected fill under the pointer, pressed and focused: Mux's
// hover and pressed fills are translucent, drawn over the selection layer a hydrated Mux Tabs bar has
// and a link does not. Hovered, it paints what that Mux Tabs bar paints.
for (const scheme of ['light', 'dark'] as const)
  for (const javaScriptEnabled of [true, false]) {
    test(`the current segment LinkTab keeps its fill and its contrast when hovered, pressed or focused (${scheme}, scripts ${javaScriptEnabled ? 'on' : 'off'})`, async ({
      browser,
      baseURL,
    }) => {
      const page = await kit(browser, baseURL!, scheme, { javaScriptEnabled });
      const current = linksOf(page, 'segment').first();
      await page.mouse.move(0, 0);
      await settle(page);
      const fill = await backgroundOf(current);
      await inEachState(page, current, javaScriptEnabled, async (state) => {
        expect(await backgroundOf(current), `${state}: the selected fill stays`).toBe(fill);
        const { contrast } = await paintOf(current);
        expect(contrast, `${state}: the text keeps 4.5:1 on it`).toBeGreaterThanOrEqual(4.5);
      });
      if (javaScriptEnabled) {
        const row = page.getByTestId('kit-tabs-segment');
        const muxTab = row.getByRole('tablist').getByRole('tab').first();
        await muxTab.hover();
        await settle(page);
        const mux = await paintOf(muxTab, row.locator('.muxui-tabs__motion-underline').first());
        await current.hover();
        await settle(page);
        expect((await paintOf(current)).back, 'hovered: painted as the hovered current Mux tab').toEqual(mux.back);
      }
      await page.context().close();
    });
  }

// In forced colours Mux paints a selected tab Highlight with HighlightText. Its hover, pressed and
// pre-hydration fills outrank that rule, so the current LinkTab must keep that pair in every state on
// its own: on a dark palette the segment tab's hover had left dark authored text on the dark page.
for (const scheme of ['light', 'dark'] as const)
  for (const javaScriptEnabled of [true, false]) {
    test(`in forced colours the current LinkTab stays Highlight when hovered, pressed or focused (${scheme}, scripts ${javaScriptEnabled ? 'on' : 'off'})`, async ({
      browser,
      baseURL,
    }) => {
      const page = await kit(browser, baseURL!, scheme, { javaScriptEnabled, forcedColors: 'active' });
      // The palette's own pair, read off a probe element that keeps forced colours off itself.
      const system = await page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement('div'));
        probe.style.cssText = 'forced-color-adjust: none; background-color: Highlight; color: HighlightText';
        const { backgroundColor, color } = getComputedStyle(probe);
        probe.remove();
        return { back: backgroundColor, text: color };
      });
      for (const variant of variants) {
        const current = linksOf(page, variant).first();
        await page.mouse.move(0, 0);
        await settle(page);
        const rest = { back: await backgroundOf(current), text: await current.evaluate((element) => getComputedStyle(element).color) };
        expect.soft(rest, `${variant}: Highlight with HighlightText at rest`).toEqual(system);
        await inEachState(page, current, javaScriptEnabled, async (state) => {
          expect.soft(await backgroundOf(current), `${variant}, ${state}: the Highlight fill stays`).toBe(rest.back);
          const { contrast } = await paintOf(current);
          expect.soft(contrast, `${variant}, ${state}: the text keeps 4.5:1 on it`).toBeGreaterThanOrEqual(4.5);
        });
      }
      await page.context().close();
    });
  }
