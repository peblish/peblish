import { expect, test, type Page } from '@playwright/test';
import { prefsCookie, skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The Commons shared pieces (PostRow, the pill vote, LinkPreview, NsfwCover, RailPanel with FactList,
// CountBadge, the skeleton hosts) through the shared state helper, in light and dark, under forced
// colours and reduced motion and at a phone's width, whatever brand pack site.brand names. Controls
// are held to 44px phone targets; a text link inside a line of text (a title, a handle, a domain, a
// fact) is held to WCAG's 24px, as in the mock.
test.beforeEach(async ({ request }) => skipWithoutKit(request));
test.setTimeout(240_000);

const compositions: Record<string, { states: string[]; target: 44 | 24 }> = {
  'post-row-card': { states: ['rest', 'selected', 'disabled', 'hover', 'focus', 'pressed'], target: 24 },
  'post-row-classic': { states: ['rest', 'selected', 'disabled', 'hover', 'focus', 'pressed'], target: 24 },
  'post-row-compact': { states: ['rest', 'selected', 'disabled', 'hover', 'focus', 'pressed'], target: 24 },
  'post-row-sensitive': { states: ['rest', 'selected', 'disabled', 'pending', 'hover', 'focus', 'pressed'], target: 24 },
  'vote-pill': { states: ['rest', 'selected', 'disabled', 'hover', 'focus', 'pressed'], target: 44 },
  'link-preview': { states: ['rest', 'disabled', 'hover', 'focus', 'pressed'], target: 24 },
  // Its revealed sample holds a text link; Show itself is held to 44 below.
  'nsfw-cover': { states: ['rest', 'selected', 'disabled', 'pending', 'hover', 'focus', 'pressed'], target: 24 },
  'rail-panel': { states: ['rest', 'hover', 'focus', 'pressed'], target: 24 },
  'count-badge': { states: ['rest', 'selected', 'hover', 'focus', 'pressed'], target: 24 },
  skeletons: { states: ['pending'], target: 44 },
};

for (const [composition, { states, target }] of Object.entries(compositions)) {
  test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
    const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
    expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
    expect(checks).toHaveLength(states.length * 2 * 4);
    expect(stateProblems(checks, { target })).toEqual([]);
  });
}

const phone = async (page: Page, baseURL: string, scheme: 'light' | 'dark' = 'light') => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().addCookies([{ ...prefsCookie('card', scheme), url: baseURL }]);
};

test('on a phone every control in a post row action row is a 44px target', async ({ page, baseURL }) => {
  await phone(page, baseURL!);
  for (const density of ['card', 'classic', 'compact']) {
    await gotoHydrated(page, `/kit/post-row-${density}`);
    const boxes = await page
      .locator('[data-kit-state] .pb-post__actions')
      .locator('button, a')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect()).map(({ width, height }) => Math.round(Math.min(width, height))),
      );
    expect(boxes.length, density).toBeGreaterThan(0);
    expect(
      boxes.filter((side) => side < 44),
      density,
    ).toEqual([]);
  }
});

test('a cast vote is filled as well as coloured, also under forced colours', async ({ browser, baseURL }) => {
  for (const forcedColors of ['none', 'active'] as const) {
    const context = await browser.newContext({ baseURL, forcedColors });
    const page = await context.newPage();
    await gotoHydrated(page, '/kit/vote-pill');
    const fill = (state: string, arrow: string) =>
      page.locator(`[data-kit-state="${state}"] button[aria-label="${arrow}"] svg`).evaluate((svg) => getComputedStyle(svg).fill);
    expect(await fill('rest', 'Upvote'), forcedColors).toBe('none');
    expect(await fill('selected', 'Upvote'), forcedColors).toBe('none');
    expect(await fill('selected', 'Downvote'), forcedColors).not.toBe('none');
    await expect(page.locator('[data-kit-state="selected"] button[aria-label="Downvote"]')).toHaveAttribute('aria-pressed', 'true');
    // The score is passive text: no live region announces each change.
    await expect(page.locator('[data-kit-state="rest"] .pb-vote__score')).not.toHaveAttribute('aria-live');
    await context.close();
  }
});

test('the cover keeps the concealed content out of the page until Show, then moves focus to it', async ({ page }) => {
  await gotoHydrated(page, '/kit/nsfw-cover');
  const rest = page.locator('[data-kit-state="rest"]');
  await expect(rest.locator('[data-kit-concealed]')).toHaveCount(0);
  await expect(rest.getByRole('link')).toHaveCount(0);
  const show = rest.getByRole('button', { name: 'Show' });
  await show.focus();
  await page.keyboard.press('Enter');
  await expect(rest.getByRole('link', { name: 'Concealed link' })).toBeVisible();
  await expect(rest.locator('.pb-cover-revealed')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(rest.getByRole('link', { name: 'Concealed link' })).toBeFocused();
  // Not eligible: Show stays, disabled. Pending: Show says so.
  await expect(page.locator('[data-kit-state="disabled"]').getByRole('button', { name: 'Show' })).toBeDisabled();
  await expect(page.locator('[data-kit-state="pending"] [data-muxui-state-pending]')).toHaveCount(1);
});

test('on a phone Show is a 44px target, in a covered slot and in place of a thumbnail, and the thumbnail cover fits', async ({
  page,
  baseURL,
}) => {
  await phone(page, baseURL!);
  for (const path of ['/kit/nsfw-cover', '/kit/post-row-sensitive']) {
    await gotoHydrated(page, path);
    const rest = page.locator('[data-kit-state="rest"]');
    const box = (await rest.getByRole('button', { name: 'Show' }).boundingBox())!;
    expect(Math.min(box.width, box.height), path).toBeGreaterThanOrEqual(44);
    // Nothing in the cover spills out of it.
    const spill = await rest.locator('.pb-cover').evaluate((cover) => {
      const outer = cover.getBoundingClientRect();
      return [...cover.children]
        .map((child) => child.getBoundingClientRect())
        .filter((inner) => inner.left < outer.left - 0.5 || inner.right > outer.right + 0.5 || inner.bottom > outer.bottom + 0.5).length;
    });
    expect(spill, path).toBe(0);
  }
});

test('a press on a row outside its links opens the post through the title link', async ({ page }) => {
  await gotoHydrated(page, '/kit/post-row-card');
  const row = page.locator('[data-kit-state="rest"] article');
  const href = await row.locator('.pb-post__title a').getAttribute('href');
  const box = (await row.locator('.pb-post__body').boundingBox())!;
  await page.mouse.click(box.x + box.width - 200, box.y + box.height - 4);
  await expect(page).toHaveURL(new RegExp(`${href}$`));
});

test('the skeleton hosts are inert: no control, nothing named but the one status, nothing moving', async ({ page }) => {
  await gotoHydrated(page, '/kit/skeletons');
  const sample = page.locator('[data-kit-state="pending"] [data-kit-sample]');
  await expect(sample.locator('a, button, input, [tabindex]')).toHaveCount(0);
  await expect(sample.getByRole('status')).toHaveText('Loading posts');
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test('a row keeps its links separate in every density: title, community, author and comments, none inside another', async ({ page }) => {
  for (const density of ['card', 'classic', 'compact']) {
    await gotoHydrated(page, `/kit/post-row-${density}`);
    const row = page.locator('[data-kit-state="rest"] article');
    await expect(row.locator('a a'), density).toHaveCount(0);
    for (const link of ['.pb-post__title a', '.pb-post__community', '.pb-post__by a', '.pb-post__comments'])
      await expect(row.locator(link), `${density} ${link}`).toHaveCount(1);
    if (density === 'card') await expect(row.locator('.pb-link-preview')).toHaveAttribute('href', /^https:/);
  }
});

test('selecting text on a row does not open the post', async ({ page }) => {
  await gotoHydrated(page, '/kit/post-row-card');
  const row = page.locator('[data-kit-state="rest"] article');
  const time = (await row.locator('.pb-post__meta time').boundingBox())!;
  const meta = (await row.locator('.pb-post__meta').boundingBox())!;
  // A drag from the age to the meta line's empty end selects text; the click it ends with must not navigate.
  await page.mouse.move(time.x + 1, time.y + time.height / 2);
  await page.mouse.down();
  await page.mouse.move(meta.x + meta.width - 4, time.y + time.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()!.toString())).not.toBe('');
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/kit\/post-row-card$/);
});

test('a vote being saved marks its group busy until the save settles', async ({ page }) => {
  await gotoHydrated(page, '/kit');
  const group = page.getByTestId('kit-vote-slow').getByRole('group');
  await group.getByRole('button', { name: 'Upvote' }).click();
  await expect(group).toHaveAttribute('aria-busy', 'true');
  await expect(group).not.toHaveAttribute('aria-busy');
});
