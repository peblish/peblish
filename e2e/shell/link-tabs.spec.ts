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

/** A kit page in its own context: a scheme, and optionally scripts off or forced colours. */
async function kit(
  browser: Browser,
  baseURL: string,
  scheme: 'light' | 'dark',
  options: { javaScriptEnabled?: boolean; forcedColors?: 'active' } = {},
) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...options });
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
