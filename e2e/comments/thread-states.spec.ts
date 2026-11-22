import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The thread's compositions on their gallery state pages (packages/web/src/routes/kit/-thread.tsx), through the shared
// state helper: every state in light and dark, under forced colours and reduced motion and at a phone's width, where
// every control is held to the state matrix's 44 px. Then the eight-level branch at a phone's width.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(180_000);

const driven = ['hover', 'focus', 'pressed'];

const compositions: Record<string, { states: string[] }> = {
  // At rest, a permalink's own comment (selected) and signed out (disabled).
  'comment-tree': { states: ['rest', 'selected', 'disabled', ...driven] },
  'comment-tombstones': { states: ['rest', ...driven] },
  // Answering a comment (selected), a locked post's reason in its place (disabled), sending, and refused.
  'reply-dock': { states: ['rest', 'selected', 'disabled', 'pending', 'invalid', ...driven] },
  // Voted on (selected) and signed out (disabled).
  'post-pills': { states: ['rest', 'selected', 'disabled', ...driven] },
};

for (const [composition, { states }] of Object.entries(compositions)) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    expect(stateProblems(checks)).toEqual([]);
  });
}

// Too tall for a phone's window between its bars, so measured here rather than through the state helper.
test('an eight-level branch stays readable on a phone: no sideways scroll, a measure kept, 44 px controls', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await gotoHydrated(page, '/kit/comment-deep');
  const sample = page.locator('[data-kit-state="rest"] [data-kit-sample]');
  const comments = sample.locator('li.pb-comment');
  await expect(comments).toHaveCount(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // Past the third level the replies stop stepping in, so the deepest keeps at least 60% of the screen's width.
  const widths = await comments
    .locator('> .pb-comment__main > .pb-comment__text')
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
  expect(widths).toHaveLength(8);
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(234);
  // From there on each reply names whom it answers, which the line no longer shows.
  for (let level = 0; level < 8; level++) {
    const to = comments.nth(level).locator('> .pb-comment__head > .pb-comment__to');
    if (level < 3) await expect(to).toHaveCount(0);
    else await expect(to).toHaveText(/^in reply to @(jun|kofi)@/);
  }
  const small = await sample.locator('button, a[href]').evaluateAll((nodes) =>
    nodes
      .filter((node) => node.checkVisibility())
      .map((node) => ({ name: node.getAttribute('aria-label') ?? node.textContent?.trim(), box: node.getBoundingClientRect() }))
      .filter(({ box }) => Math.min(box.width, box.height) < 44)
      .map(({ name, box }) => `${name}: ${Math.round(box.width)}×${Math.round(box.height)}`),
  );
  expect(small).toEqual([]);
  await context.close();
});
