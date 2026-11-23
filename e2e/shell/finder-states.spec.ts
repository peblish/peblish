import { expect, test } from '@playwright/test';
import { colours } from '../support/contrast.ts';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The header finder's contents and Create post's community field through the shared state helper, in light and
// dark, under forced colours and reduced motion and at a phone's width, whatever brand pack site.brand names.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(240_000);

const compositions: Record<string, string[]> = {
  'community-finder': ['rest', 'pending', 'invalid', 'hover', 'focus', 'pressed'],
  'community-finder-empty': ['rest', 'hover', 'focus', 'pressed'],
  'community-finder-none': ['rest', 'hover', 'focus', 'pressed'],
  'community-finder-lookup': ['rest', 'hover', 'focus', 'pressed'],
  'community-field': ['rest', 'selected', 'invalid', 'hover', 'focus', 'pressed'],
};

for (const [composition, states] of Object.entries(compositions)) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    const problems = stateProblems(checks, { target: 44 });
    // ComboBox's field is drawn by the control around its input, which takes the focus colour as its edge: the helper
    // looks for it on the input, so it is measured below instead.
    expect(composition === 'community-field' ? problems.filter((problem) => !problem.endsWith('focus ring missing')) : problems).toEqual(
      [],
    );
  });
}

test('the community field’s edge, or its forced-colours ring, is 3:1 or more when its input has keyboard focus', async ({
  browser,
  baseURL,
}) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const forcedColors of ['none', 'active'] as const) {
      const context = await browser.newContext({ baseURL, colorScheme, forcedColors });
      const page = await context.newPage();
      await gotoHydrated(page, '/kit/community-field');
      const sample = page.locator('[data-kit-state="rest"]');
      await page.keyboard.press('Tab');
      await sample.getByRole('combobox').focus();
      // The edge eases into the focus colour.
      await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)));
      // Its edge takes the focus colour; under forced colours Mux draws a Highlight ring outside it instead.
      const { border, outline } = await colours(sample.locator('.muxui-combo-box__control'));
      expect(
        (forcedColors === 'active' ? outline : border)?.ratio,
        `${colorScheme}, forced colours ${forcedColors}`,
      ).toBeGreaterThanOrEqual(3);
      await context.close();
    }
  }
});
