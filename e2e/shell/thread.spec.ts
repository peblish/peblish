import { expect, test } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The comment tree: folds by keyboard, low-score and removed comments, badges, the depth cap
// and its "Continue this thread" link, and client-side navigation from links (TanStack Router
// issue 7088: Enter on a React Aria link must navigate once, in the page, not reload it).
test.beforeEach(({ request }) => skipWithoutKit(request));

test('a comment folds and unfolds from the keyboard', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const thread = page.getByTestId('kit-thread');
  const first = thread.getByRole('button', { name: 'Collapse comment and 4 replies' });
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(thread.getByText('Pinned the test checklist')).toBeVisible();

  await first.focus();
  await page.keyboard.press('Enter');
  const expand = thread.getByRole('button', { name: 'Expand comment and 4 replies' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(thread.getByText('Pinned the test checklist')).toBeHidden();
  await expect(thread.getByText('4 replies hidden.')).toBeVisible();

  await expand.focus();
  await page.keyboard.press('Space');
  await expect(thread.getByText('Pinned the test checklist')).toBeVisible();
});

test('Tab walks the controls in reading order', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const thread = page.getByTestId('kit-thread');
  await thread.getByRole('button', { name: 'Collapse comment and 4 replies' }).focus();
  const order: string[] = [];
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('Tab');
    order.push(
      await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? ''),
    );
  }
  // The author link, the vote arrows, reply and share, then the next comment's fold button.
  expect(order.slice(0, 5)).toEqual(['@jun@lemmy.world', 'Upvote', 'Downvote', 'reply', 'share']);
  expect(order[5]).toMatch(/^Collapse comment/);
});

test('a low-score comment starts folded, a removed one shows a note, and badges name who is who', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const thread = page.getByTestId('kit-thread');
  await expect(thread.getByText('Collapsed, score -9 is below -5. 1 reply hidden.')).toBeVisible();
  await expect(thread.getByText('Buy followers cheap.')).toBeHidden();
  await thread.getByRole('button', { name: 'show' }).click();
  await expect(thread.getByText('Buy followers cheap.')).toBeVisible();
  await expect(thread.getByText('[removed by a moderator]')).toBeVisible();
  await expect(thread.getByText('[deleted]')).toHaveCount(2);
  await expect(thread.locator('.pb-badge--op').first()).toHaveText('OP');
  await expect(thread.locator('.pb-badge--moderator').first()).toHaveText('MOD');
});

test('a 50-level thread stops at the depth cap and continues on its own page', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const deep = page.getByTestId('kit-deep-thread');
  await expect(deep.getByText('Reply at depth 6.')).toBeVisible();
  await expect(deep.getByText('Reply at depth 7.')).toHaveCount(0);
  const next = deep.getByRole('link', { name: 'Continue this thread' });
  await expect(next).toHaveCount(1);
  await expect(next).toHaveAttribute('href', /\/post\/[^/]+\/comments\/d6$/);
  await expect(deep.getByText('44 more replies')).toBeVisible();

  // Enter on the link follows it. The page does not exist yet (lane D), so the router hands it to the browser.
  await next.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/comments\/d6$/);
});

test('Enter on a Mux link navigates in the page, once', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const before = await page.evaluate(() => {
    (window as unknown as { __survives: boolean }).__survives = true;
    return history.length;
  });
  const link = page.getByRole('link', { name: 'Sign in (Mux link)' });
  await link.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL('**/auth/sign-in');
  await page.locator('html[data-hydrated="1"]').waitFor();
  // The same document: our marker is still there, no navigation entry was added by a reload, and one history entry was pushed.
  expect(await page.evaluate(() => (window as unknown as { __survives?: boolean }).__survives)).toBe(true);
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
});

test("plain links in the app's own components navigate in the page too", async ({ page }) => {
  await gotoHydrated(page, '/kit');
  await page.evaluate(() => {
    (window as unknown as { __survives: boolean }).__survives = true;
  });
  await page.getByRole('link', { name: 'Sign in', exact: true }).first().click();
  await page.waitForURL('**/auth/sign-in');
  await page.locator('html[data-hydrated="1"]').waitFor();
  expect(await page.evaluate(() => (window as unknown as { __survives?: boolean }).__survives)).toBe(true);
  // Back returns to the gallery without a reload as well.
  await page.goBack();
  await page.waitForURL('**/kit');
  expect(await page.evaluate(() => (window as unknown as { __survives?: boolean }).__survives)).toBe(true);
});
