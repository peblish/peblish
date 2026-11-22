import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// "New since your last visit" on its gallery state page (packages/web/src/routes/kit/-visits.tsx), through the
// shared state helper: the jump and the marked comments at rest, hovered, focused and pressed, and the count whose new
// comments are on other pages (disabled), in light and dark, under forced colours and reduced motion and at a
// phone's width, with axe and the 44 px targets. The journeys are in new-since.spec.ts.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(180_000);

test('/kit/new-since: every state, scheme and condition passes', async ({ browser, baseURL }) => {
  const states = ['rest', 'disabled', 'hover', 'focus', 'pressed'];
  const checks = await galleryStates(browser, baseURL!, '/kit/new-since');
  expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
  expect(checks).toHaveLength(states.length * 2 * 4);
  expect(stateProblems(checks)).toEqual([]);
});

test('/kit/new-since: the jump opens a folded parent before it moves focus and says where, round again', async ({ page }) => {
  await gotoHydrated(page, '/kit/new-since');
  const sample = page.locator('[data-kit-state="rest"]');
  const jump = sample.getByRole('link', { name: '3 new since your last visit' });
  const status = sample.locator('.th-head [role="status"]');
  const row = (key: string) => page.locator(`#comment-on-${key}`);
  const text = (key: string) => row(key).locator('> .pb-comment__main .pb-comment__text');
  const fold = (key: string) => row(key).locator('> .pb-comment__head .pb-comment__fold');

  // The reply under the low-scored comment is drawn but hidden: the jump opens its parent, then focuses it.
  await expect(text('f')).toBeHidden();
  for (const [index, key] of ['b', 'd', 'f', 'b'].entries()) {
    await jump.focus();
    await page.keyboard.press('Enter');
    await expect(row(key)).toBeFocused();
    await expect(row(key)).toBeInViewport();
    await expect(status).toHaveText(`New comment ${(index % 3) + 1} of 3`);
  }
  await expect(text('f')).toBeVisible();
  await expect(row('e')).not.toHaveAttribute('data-folded');

  // A parent the reader folds by hand takes its replies off the page; the jump opens it again for its new reply.
  await page.reload();
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await fold('a').click();
  await expect(row('b')).toHaveCount(0);
  await jump.click();
  await expect(row('b')).toBeFocused();
  await expect(status).toHaveText('New comment 1 of 3');
  await expect(page).not.toHaveURL(/#/);
});

test('/kit/new-since: without scripts the jump is a link to the first new comment, which is on the page', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/kit/new-since');
  const jump = page.locator('[data-kit-state="rest"]').getByRole('link', { name: '3 new since your last visit' });
  await expect(jump).toHaveAttribute('href', '#comment-on-b');
  await jump.click();
  await expect(page.locator('#comment-on-b')).toBeInViewport();
  await context.close();
});
