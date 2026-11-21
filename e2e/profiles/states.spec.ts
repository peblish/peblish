import { expect, test } from '@playwright/test';
import { ratio, type Rgb } from '../support/contrast.ts';
import { prefsCookie, skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The people area's compositions (a profile's header and tabs, the You page's links and Appearance) through
// the shared state helper, in light and dark, under forced colours and reduced motion and at a phone's width:
// every control is a 44px phone target.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(240_000);

const compositions: Record<string, string[]> = {
  'profile-header': ['rest', 'hover', 'focus', 'pressed'],
  'profile-tabs': ['rest', 'selected', 'hover', 'focus', 'pressed'],
  'you-links': ['rest', 'hover', 'focus', 'pressed'],
  'you-appearance': ['rest', 'selected', 'disabled', 'hover', 'focus', 'pressed'],
};

/**
 * The helper sees only an element's ancestors. Mux's ToggleButtonGroup draws its selected choice as a copy of the
 * labels in inverse colours over an indicator that is their sibling, so the helper reads that copy against the page
 * (1:1). Appearance drops those readings and measures the pair itself below.
 */
const unseenLayer = (composition: string, problem: string) => composition === 'you-appearance' && problem.endsWith(': text 1:1');

for (const [composition, states] of Object.entries(compositions)) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    expect(stateProblems(checks, { target: 44 }).filter((problem) => !unseenLayer(composition, problem))).toEqual([]);
  });
}

test("Appearance's selected choice reads at 4.5:1 on its indicator, in light and dark", async ({ page, baseURL }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.context().addCookies([{ ...prefsCookie('card', scheme), url: baseURL! }]);
    await gotoHydrated(page, '/kit/you-appearance');
    for (const state of ['rest', 'selected']) {
      const group = page.locator(`[data-kit-state="${state}"] .muxui-toggle-button-group`);
      const [fore, back] = await group.evaluate((element) => {
        const rgb = (colour: string) => {
          const context = document.createElement('canvas').getContext('2d')!;
          context.fillStyle = colour;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
        };
        const label = element.querySelector('.muxui-toggle-button-group__motion-foreground button')!;
        const indicator = element.querySelector('.muxui-toggle-button-group__motion-indicator')!;
        return [rgb(getComputedStyle(label).color), rgb(getComputedStyle(indicator).backgroundColor)];
      });
      expect(ratio(fore as Rgb, back as Rgb), `${scheme} ${state}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
