import { expect, test, type Page } from '@playwright/test';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The first tap right after the hydration marker, with the CPU slowed 6x (Chrome DevTools
// Protocol), must not be lost: the mux-start spike lost 33 of 288 first clicks on Tabs and
// Table rows. The vote arrows and the density control are Mux ToggleButtons, checked here.
test.beforeEach(({ request }) => skipWithoutKit(request));
test.setTimeout(120_000);

async function throttled(page: Page, rate: number) {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
}

const attempts = 8;

test(`the first tap on a vote arrow works at 6x CPU throttling (${attempts} cold loads)`, async ({ browser }) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await throttled(page, 6);
    await gotoHydrated(page, '/kit');
    const vote = page.getByTestId('kit-vote-column').getByRole('group', { name: 'Vote' });
    await vote.getByRole('button', { name: 'Upvote' }).click({ timeout: 10_000 });
    await expect(vote.getByRole('button', { name: 'Upvote' }), `attempt ${attempt + 1}`).toHaveAttribute('aria-pressed', 'true');
    await expect(vote).toContainText('843');
    await context.close();
  }
});

test('a press on a vote arrow while the page is still hydrating makes exactly one vote', async ({ page }) => {
  // The CPU slowed 20x holds hydration open: the shell marker (React is running and listening)
  // comes about a second before the route marker (the route content is interactive). The press
  // lands in between, on server-rendered arrows, and React must replay it once.
  await throttled(page, 20);
  await page.addInitScript(() => {
    document.addEventListener(
      'pointerdown',
      () => {
        const html = document.documentElement;
        Object.assign(window, { pressedDuringHydration: html.dataset.shellHydrated === '1' && html.dataset.hydrated !== '1' });
      },
      { capture: true, once: true },
    );
  });
  await page.goto('/kit', { waitUntil: 'commit' });
  await page.locator('html[data-shell-hydrated="1"]').waitFor({ state: 'attached' });
  const slow = page.getByTestId('kit-vote-slow');
  const up = slow.getByRole('button', { name: 'Upvote' });
  await up.click({ timeout: 10_000 });
  expect(await page.evaluate(() => (window as { pressedDuringHydration?: boolean }).pressedDuringHydration)).toBe(true);
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await expect(up).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
  await expect(slow.getByRole('group')).toContainText('6');
  // The saver saw one vote, and no second one follows.
  await expect(page.getByTestId('kit-vote-slow-log')).toHaveText('1', { timeout: 15_000 });
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('kit-vote-slow-log')).toHaveText('1');
});

test('a vote can be taken back, and a refused vote goes back to what it was', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const vote = page.getByTestId('kit-vote-column').getByRole('group', { name: 'Vote' });
  await vote.getByRole('button', { name: 'Downvote' }).click();
  await expect(vote).toContainText('841');
  await vote.getByRole('button', { name: 'Upvote' }).click();
  await expect(vote).toContainText('843');
  await vote.getByRole('button', { name: 'Upvote' }).click();
  await expect(vote).toContainText('842');
  await expect(vote.getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'false');

  // The saver refused the vote: the arrows and the score go back.
  const refused = page.getByTestId('kit-vote-refused').getByRole('group', { name: 'Vote' });
  await refused.getByRole('button', { name: 'Upvote' }).click();
  await expect(refused).toContainText('7');
  await expect(refused.getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'false');
});

test('votes made while one is being saved are sent one at a time, newest last', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const slow = page.getByTestId('kit-vote-slow');
  const vote = slow.getByRole('group', { name: 'Vote' });
  // Up, down, up, down in quick succession: the arrows follow every press at once ...
  await vote.getByRole('button', { name: 'Upvote' }).click();
  await vote.getByRole('button', { name: 'Downvote' }).click();
  await vote.getByRole('button', { name: 'Upvote' }).click();
  await vote.getByRole('button', { name: 'Downvote' }).click();
  await expect(vote.getByRole('button', { name: 'Downvote' })).toHaveAttribute('aria-pressed', 'true');
  await expect(vote).toContainText('4');
  // ... and the server sees the first vote, then only the newest, with no request overlapping another.
  await expect(page.getByTestId('kit-vote-slow-log')).toHaveText('1,-1');
  await expect(vote.getByRole('button', { name: 'Downvote' })).toHaveAttribute('aria-pressed', 'true');
  await expect(vote).toContainText('4');
});

test('a refusal that arrives after a newer choice does not undo it', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const vote = page.getByTestId('kit-vote-slow-refusing').getByRole('group', { name: 'Vote' });
  await vote.getByRole('button', { name: 'Upvote' }).click();
  await vote.getByRole('button', { name: 'Downvote' }).click();
  await expect(page.getByTestId('kit-vote-slow-refusing-log')).toHaveText('1!,-1');
  await expect(vote.getByRole('button', { name: 'Downvote' })).toHaveAttribute('aria-pressed', 'true');
  await expect(vote.getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'false');
  await expect(vote).toContainText('4');
});

test(`the first tap on the density control works at 6x CPU throttling (${attempts} cold loads)`, async ({ browser }) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await throttled(page, 6);
    await gotoHydrated(page, '/kit');
    await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Compact' }).click({ timeout: 10_000 });
    await expect(page.getByTestId('kit-feed').locator('article').first(), `attempt ${attempt + 1}`).toHaveAttribute(
      'data-density',
      'compact',
    );
    await context.close();
  }
});
