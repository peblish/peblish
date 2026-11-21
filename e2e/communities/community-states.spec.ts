import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { ratio, type Rgb } from '../support/contrast.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The community page's and the directory's compositions (Join in every state, the directory's List and
// Cards, the view switch, the loading list) through the shared state helper, in light and dark, under
// forced colours and reduced motion and at a phone's width, whatever brand pack site.brand names.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(240_000);

const compositions: Record<string, string[]> = {
  'join-button': ['rest', 'selected', 'pending', 'invalid', 'hover', 'focus', 'pressed'],
  'join-button-requested': ['rest', 'pending', 'invalid', 'hover', 'focus', 'pressed'],
  'community-list': ['rest', 'hover', 'focus', 'pressed'],
  'community-cards': ['rest', 'hover', 'focus', 'pressed'],
  'community-view': ['rest', 'selected', 'hover', 'focus', 'pressed'],
  'community-skeleton': ['pending'],
};

for (const [composition, states] of Object.entries(compositions)) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    // Mux's ToggleButtonGroup draws the chosen label twice: the button's own, and a hidden copy in the
    // inverse colour clipped over its moving indicator, a sibling the shared helper does not see behind it,
    // so it measures that copy against the page (1:1). The pair is measured below instead.
    const problems = stateProblems(checks, { target: 44 });
    expect(composition === 'community-view' ? problems.filter((problem) => !problem.endsWith(' text 1:1')) : problems).toEqual([]);
  });
}

test('the view switch’s chosen label reads on its indicator in light and dark', async ({ browser, baseURL }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ baseURL, colorScheme });
    const page = await context.newPage();
    await gotoHydrated(page, '/kit/community-view');
    const group = page.locator('[data-kit-state="rest"] .pb-cview');
    const rgb = (value: string) =>
      value
        .match(/\d+(\.\d+)?/g)!
        .slice(0, 3)
        .map(Number) as Rgb;
    const label = rgb(
      await group
        .locator('.muxui-toggle-button-group__motion-label')
        .first()
        .evaluate((node) => getComputedStyle(node).color),
    );
    const indicator = rgb(
      await group.locator('.muxui-toggle-button-group__motion-indicator').evaluate((node) => getComputedStyle(node).backgroundColor),
    );
    expect(ratio(label, indicator), colorScheme).toBeGreaterThanOrEqual(4.5);
    await context.close();
  }
});

test('Joined and Pending carry a glyph and say what a press does; a refusal is the button’s description', async ({ page }) => {
  await gotoHydrated(page, '/kit/join-button');
  const joined = page.locator('[data-kit-state="selected"]').getByRole('button');
  await expect(joined).toHaveAccessibleName('Joined, Leave this community');
  await expect(joined.locator('svg')).toHaveCount(1);
  const requested = page.getByRole('button', { name: 'Pending, Cancel the request' });
  await gotoHydrated(page, '/kit/join-button-requested');
  await expect(requested.first()).toBeVisible();
  await expect(requested.first().locator('svg')).toHaveCount(1);
  await gotoHydrated(page, '/kit/join-button');
  const failed = page.locator('[data-kit-state="invalid"]');
  await expect(failed.getByRole('alert')).toHaveText('Something went wrong. Try again.');
  await expect(failed.getByRole('button', { name: 'Join', exact: true })).toHaveAccessibleDescription('Something went wrong. Try again.');
  // Busy, the button keeps its place and says so.
  await expect(page.locator('[data-kit-state="pending"]').getByRole('button')).toHaveAttribute('aria-busy', 'true');
});
