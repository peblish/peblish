import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The saves lane's compositions through the shared state helper, in light and dark, under forced colours
// and reduced motion and at a phone's width: the post page's Save and Unsave (saved, pending, refused), a
// Saved row's Unsave, the feed row menu with Save, and the Saved page's empty state and page links. Controls
// are 44px phone targets; the page links and the empty state's link are text links, held to WCAG's 24px.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(240_000);

const driven = ['hover', 'focus', 'pressed'];
const compositions: Record<string, { states: string[]; target: 44 | 24 }> = {
  'post-save': { states: ['rest', 'selected', 'pending', 'invalid', ...driven], target: 44 },
  'saved-unsave': { states: ['rest', 'pending', 'invalid', ...driven], target: 44 },
  'feed-row-save': { states: ['rest', 'selected', 'pending', 'invalid', ...driven], target: 44 },
  'saved-empty': { states: ['rest', ...driven], target: 24 },
  'saved-pages': { states: ['rest', 'selected', ...driven], target: 24 },
};

for (const [composition, { states, target }] of Object.entries(compositions)) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    expect(stateProblems(checks, { target })).toEqual([]);
  });
}

test('the menu names Save by the post’s state and disables it while a save is on its way', async ({ page }) => {
  await gotoHydrated(page, '/kit/feed-row-save');
  for (const [state, label, disabled] of [
    ['rest', 'Save', false],
    ['selected', 'Unsave', false],
    ['pending', 'Save', true],
  ] as const) {
    await page
      .locator(`[data-kit-state="${state}"]`)
      .getByRole('button', { name: /^More actions for / })
      .click();
    const item = page.getByRole('menuitem', { name: label, exact: true });
    await expect(item).toBeVisible();
    if (disabled) await expect(item).toHaveAttribute('aria-disabled', 'true');
    else await expect(item).not.toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  }
});

test('a pending Save is busy and named; a refused one says why in an alert', async ({ page }) => {
  await gotoHydrated(page, '/kit/post-save');
  await expect(page.locator('[data-kit-state="pending"] form')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('[data-kit-state="invalid"]').getByRole('alert')).toHaveText('Not saved. Try again.');
  await expect(page.locator('[data-kit-state="selected"]').getByRole('status')).toHaveText('Saved.');
  await expect(page.locator('[data-kit-state="rest"]').getByRole('button', { name: 'Save', exact: true })).toBeVisible();
});
