import { expect, test } from '@playwright/test';
import { prefsCookie, skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The feed lane's compositions through the shared state helper, in light and dark, under forced colours and
// reduced motion and at a phone's width: the header's Sort and View menus, a row's Copy link menu and its
// confirmation, the ends of a list that loads by itself (Retry with the next-page link, the pending
// batch, the end line) and Skip past the posts. Controls are 44px phone targets; the next-page link
// beside Retry is a text link, held to WCAG's 24px.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(240_000);

const compositions: Record<string, { states: string[]; target: 44 | 24 }> = {
  'feed-sort-menu': { states: ['rest', 'selected', 'disabled', 'hover', 'focus', 'pressed'], target: 44 },
  'feed-view-menu': { states: ['rest', 'disabled', 'hover', 'focus', 'pressed'], target: 44 },
  'feed-row-actions': { states: ['rest', 'selected', 'disabled', 'hover', 'focus', 'pressed'], target: 44 },
  'feed-retry': { states: ['rest', 'pending', 'hover', 'focus', 'pressed'], target: 24 },
  'feed-end': { states: ['rest', 'hover', 'focus', 'pressed'], target: 24 },
  'feed-skip': { states: ['rest', 'disabled', 'hover', 'focus', 'pressed'], target: 44 },
};

for (const [composition, { states, target }] of Object.entries(compositions)) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    expect(stateProblems(checks, { target })).toEqual([]);
  });
}

test('on a phone Retry is a 44px target', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([{ ...prefsCookie('card', 'light'), url: baseURL! }]);
  await gotoHydrated(page, '/kit/feed-retry');
  const box = (await page.locator('[data-kit-state="rest"]').getByRole('button', { name: 'Retry' }).boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
});

test('a menu ticks the choice in force and says so; the pending batch has no status of its own', async ({ page }) => {
  await gotoHydrated(page, '/kit/feed-sort-menu');
  const trigger = page.locator('[data-kit-state="selected"]').getByRole('button', { name: 'Sort: Top, Week' });
  await expect(trigger).toContainText('Top Week');
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Top' }).hover();
  // Mux's Menu has no checked items yet: the one in force is ticked, and "current" is its description.
  await expect(page.getByRole('menuitem', { name: 'Week' })).toHaveAccessibleDescription('current');
  await expect(page.getByRole('menuitem', { name: 'Day' })).toHaveAccessibleDescription('');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await gotoHydrated(page, '/kit/feed-retry');
  await expect(page.locator('[data-kit-state="pending"]').getByRole('status')).toHaveCount(0);
});
