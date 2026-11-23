import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectAccessible } from '../auth/support.ts';
import { prefsCookie, skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// Rail facts (branch 5, lane f-facts): a profile's Moderates and its home instance's software, and a
// thread's people, last activity and language, as this server can know them.

type Seed = { subject: string; open: string; hidden: string[]; remote: string; quiet: string; post: string };

test.describe('seeded', () => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
  let seed: Seed;
  // Wide enough for the rail beside the centre column and the open sidebar.
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeAll(() => {
    seed = JSON.parse(
      execFileSync('node', ['packages/core/src/testing/seed-facts.ts', 'profile'], {
        cwd: join(import.meta.dirname, '../..'),
        encoding: 'utf8',
      }),
    ) as Seed;
  });

  test('Moderates links the communities the person moderates that the reader may see, and no others', async ({ page, browser }) => {
    await gotoHydrated(page, `/u/${seed.subject}`);
    const rail = page.getByRole('complementary');
    const moderates = rail
      .getByRole('region', { name: 'Moderates' })
      .or(rail.locator('section', { hasText: 'Moderates' }))
      .first();
    await expect(moderates.getByRole('link', { name: `!${seed.open}` })).toHaveAttribute('href', `/c/${seed.open}`);
    // A removed community and a sensitive one (the reader is signed out) are nowhere in the page or its data.
    const html = await page.content();
    for (const hidden of seed.hidden) expect(html).not.toContain(hidden);
    await expectAccessible(page);
    // Without scripts the rail is the server's.
    const plain = await (await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } })).newPage();
    await plain.goto(new URL(`/u/${seed.subject}`, page.url()).href);
    await expect(
      plain.getByRole('complementary', { name: 'About this person' }).getByRole('link', { name: `!${seed.open}` }),
    ).toBeVisible();
  });

  test('a remote person’s home names its software, or says it is unknown', async ({ page }) => {
    await gotoHydrated(page, `/u/${seed.remote}`);
    const rail = page.getByRole('complementary', { name: 'About this person' });
    await expect(rail.getByText('Software', { exact: true })).toBeVisible();
    await expect(rail.getByText('Mbin', { exact: true })).toBeVisible();
    await gotoHydrated(page, `/u/${seed.quiet}`);
    await expect(page.getByRole('complementary', { name: 'About this person' }).getByText('Unknown', { exact: true })).toBeVisible();
  });

  test('the thread rail counts its people and names its language and last activity', async ({ page }) => {
    await gotoHydrated(page, `/post/${seed.post}`);
    const rail = page.getByRole('complementary', { name: 'About this post' });
    const fact = (label: string) => rail.locator('.pb-facts__item', { has: page.getByText(label, { exact: true }) }).locator('dd');
    await expect(fact('People')).toHaveText('3');
    await expect(fact('Language')).toHaveText('German');
    await expect(fact('Last activity').locator('time')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT/);
    await expectAccessible(page);
  });
});

test.describe('the gallery', () => {
  test.beforeEach(async ({ request }) => skipWithoutKit(request));
  test.setTimeout(240_000);

  for (const composition of ['profile-moderates', 'profile-moderates-more'])
    test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
      const states = ['rest', 'hover', 'focus', 'pressed'];
      const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
      expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
      expect(checks).toHaveLength(states.length * 2 * 4);
      expect(stateProblems(checks, { target: 44 })).toEqual([]);
    });

  // The thread's facts hold no control: they are read in light and dark and under forced colours.
  for (const path of ['/kit/thread-facts', '/kit/thread-facts-unknown'])
    test(`${path} reads in light and dark, and under forced colours`, async ({ browser, baseURL }) => {
      for (const scheme of ['light', 'dark'] as const)
        for (const forcedColors of ['none', 'active'] as const) {
          const context = await browser.newContext({ baseURL, colorScheme: scheme, forcedColors });
          await context.addCookies([{ ...prefsCookie('card', scheme), url: baseURL! }]);
          const page = await context.newPage();
          await gotoHydrated(page, path);
          await expectAccessible(page);
          await context.close();
        }
    });
});
