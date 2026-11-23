import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { colours } from '../support/contrast.ts';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';
import { open, settled } from './banner-support.ts';

// The site banner and the admin form's controls on their gallery pages (/kit/<key>, routes/kit/-banner-pieces.tsx):
// every state, scheme and condition through the shared helper, and the pictures (the previews, the width preview), which have no
// control to drive.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(300_000);

const driven = ['rest', 'hover', 'focus', 'pressed'];
const pages: Record<string, string[]> = {
  'site-banner': driven,
  'site-banner-solid': driven,
  'site-banner-custom': driven,
  'site-banner-translucent': driven,
  'site-banner-link': driven,
  'site-banner-dismiss': driven,
  'site-banner-short': driven,
  'banner-form-address': ['rest', 'invalid', 'hover', 'focus', 'pressed'],
  'banner-form-message': ['rest', 'invalid', 'hover', 'focus', 'pressed'],
  'banner-form-colour': ['rest', 'invalid', 'hover', 'focus', 'pressed'],
  'banner-form-icon': ['rest', 'selected', 'hover', 'focus', 'pressed'],
  'banner-form-publish': ['rest', 'disabled', 'pending', 'hover', 'focus', 'pressed'],
  'banner-form-show-again': ['rest', 'disabled', 'hover', 'focus', 'pressed'],
};

for (const [composition, states] of Object.entries(pages)) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    expect(stateProblems(checks, { target: 44 })).toEqual([]);
  });
}

/**
 * Mux's choice controls (a Switch, a RadioGroup) draw over a native input kept off screen, which the shared helper
 * cannot hover or press, and draw their focus ring on a part of their own (the indicator, or the switch's ::before).
 * So for them: every sample passes axe and keeps its text at 4.5:1 in light and dark, under forced colours and at a
 * phone's width, where each option is a 44px target; then the first option, hovered, pressed and focused from the
 * keyboard, with its ring at 3:1 against the page.
 */
const choices = ['banner-form-shown', 'banner-form-tone', 'width-presets'];

for (const composition of choices) {
  test(`/kit/${composition}: every sample, scheme and condition, and the first option driven`, async ({ browser, baseURL }) => {
    const problems: string[] = [];
    for (const scheme of ['light', 'dark'] as const)
      for (const condition of ['default', 'forced colours', 'phone'] as const) {
        const phone = condition === 'phone';
        const page = await open(browser, baseURL!, `/kit/${composition}`, scheme, {
          viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
          hasTouch: phone,
          forcedColors: condition === 'forced colours' ? 'active' : 'none',
        });
        const where = (state: string) => `${scheme} ${condition} ${state}`;
        const audit = async (state: string) => {
          const { violations } = await new AxeBuilder({ page }).include('[data-kit-state]').analyze();
          for (const { id } of violations) problems.push(`${where(state)}: ${id}`);
          for (const sample of await page.locator('[data-kit-state]:not([data-kit-state="pending"]) [data-kit-sample]').all()) {
            const ratio = (await colours(sample)).text?.ratio ?? 21;
            if (ratio < 4.5) problems.push(`${where(state)}: text ${ratio}`);
          }
        };
        await audit('shown');
        if (phone)
          for (const option of await page.locator('[data-kit-sample] label').all()) {
            const box = (await option.boundingBox())!;
            if (box.height < 44) problems.push(`${where('shown')}: option ${Math.round(box.width)}×${Math.round(box.height)} px`);
          }
        if (condition === 'default') {
          const option = page.locator('[data-kit-state="rest"] [data-kit-sample] label').first();
          await option.hover();
          await settled(page);
          await audit('hover');
          const box = (await option.boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await settled(page);
          await audit('pressed');
          await page.mouse.move(0, 0);
          await page.mouse.up();
          // Back to rest: the press above, released away, chose nothing.
          await page.keyboard.press('Tab');
          await option.locator('input').focus();
          await settled(page);
          await audit('focus');
          const ring = await option.evaluate((label) => {
            const part = label.querySelector('[class$="__indicator"]');
            const switchRing = getComputedStyle(label, '::before');
            const style = label.matches('.muxui-switch') ? switchRing : getComputedStyle(part!);
            // Mux's ring is a two-layer shadow, a gap then the ring: the widest, last layer is the ring.
            const shadow = style.boxShadow.match(/rgba?\([^)]*\)/g)?.at(-1);
            return style.outlineStyle !== 'none' && style.outlineWidth !== '0px' ? style.outlineColor : (shadow ?? null);
          });
          if (!ring) problems.push(`${where('focus')}: no ring`);
          else {
            const page_ = await page.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor);
            const value = await page.evaluate(
              ([fore, back]) => {
                const read = (colour: string) => {
                  const context = document.createElement('canvas').getContext('2d')!;
                  context.fillStyle = colour;
                  context.fillRect(0, 0, 1, 1);
                  return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
                };
                const lum = (rgb: number[]) => {
                  const [r, g, b] = rgb.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
                  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
                };
                const [a, b] = [lum(read(fore)), lum(read(back))].sort((x, y) => y - x);
                return (a! + 0.05) / (b! + 0.05);
              },
              [ring, page_] as const,
            );
            if (value < 3) problems.push(`${where('focus')}: ring ${value.toFixed(2)}`);
          }
        }
        await page.context().close();
      }
    expect(problems).toEqual([]);
  });
}

test('a custom colour Mux cannot keep readable is drawn in black or white text, and a translucent one falls back to the tone', async ({
  browser,
  baseURL,
}) => {
  const page = await open(browser, baseURL!, '/kit/site-banner-custom', 'light');
  const custom = page.getByRole('region', { name: 'Site notice' });
  await expect(custom).toHaveAttribute('data-muxui-tone', 'custom');
  expect((await colours(custom.locator('.muxui-banner__message'))).text!.ratio).toBeGreaterThanOrEqual(4.5);
  await gotoHydrated(page, '/kit/site-banner-translucent');
  await expect(page.getByRole('region', { name: 'Site notice' })).toHaveAttribute('data-muxui-tone', 'neutral');
  await page.context().close();
});

test('the pictures: the banner with no control, the previews and the width preview pass axe in light, dark and forced colours', async ({
  browser,
  baseURL,
}) => {
  for (const path of ['/kit/site-banner-plain', '/kit/site-banner-previews', '/kit/width-preview'])
    for (const scheme of ['light', 'dark'] as const)
      for (const forcedColors of ['none', 'active'] as const) {
        const page = await open(browser, baseURL!, path, scheme, { forcedColors });
        const { violations } = await new AxeBuilder({ page }).include('[data-kit-state]').analyze();
        expect(
          violations.map(({ id }) => id),
          `${path} ${scheme} ${forcedColors}`,
        ).toEqual([]);
        // Nothing in a preview can be reached with Tab.
        if (path === '/kit/site-banner-previews') {
          await expect(page.locator('.pb-banner-preview [inert]')).toHaveCount(2);
          for (const region of await page.locator('.pb-banner-preview .muxui-banner').all())
            expect((await colours(region.locator('.muxui-banner__message'))).text!.ratio).toBeGreaterThanOrEqual(4.5);
        }
        await page.context().close();
      }
});
