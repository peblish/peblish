import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, freshTotp, landed, signIn } from '../auth/support.ts';
import { plain, seedReports, signedIn, type Seed } from '../reports/support.ts';
import { skipWithoutKit } from '../support/kit.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { galleryStates, stateProblems } from '../support/states.ts';

// The report queue by community (branch 5, lane f-facts): a section per community the viewer may see,
// each named by its heading and counted, over the queue's own rows. A moderator is never sent another
// community's name, rows or count; the admins' own reports are one section for admins alone.

const queue = '/admin/reports';
// By its exact name: each section's table card is a region too, named for the same community ("Reports in !art").
const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test.describe('seeded', () => {
  test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
  test.describe.configure({ mode: 'serial' });
  let seed: Seed;
  test.beforeAll(() => {
    seed = seedReports();
  });

  test('a moderator gets one section, their community’s, counted, and nothing of another, even when they name it', async ({ browser }) => {
    const page = await plain(browser);
    await signedIn(page, seed, seed.moderator.name);
    for (const named of [null, seed.other.handle, `!${seed.other.handle}`]) {
      await page.goto(named ? `${queue}?community=${encodeURIComponent(named)}` : queue);
      const mine = section(page, `!${seed.community.handle}`);
      await expect(mine.getByRole('heading', { level: 2 }).getByRole('link')).toHaveAttribute('href', `/c/${seed.community.handle}`);
      // Hate, sensitive, remove, escalate and dismiss: five groups wait in the community.
      await expect(mine).toContainText('5 waiting');
      await expect(mine.locator('tbody tr', { hasText: seed.titles.hate })).toBeVisible();
      await expect(section(page, 'People and admins-only reports')).toHaveCount(0);
      // The whole document and its loader data, less the router's echo of the address's own search.
      const html = (await page.content()).replaceAll(`{\\"community\\":\\"${named}\\"}`, '');
      expect(html).not.toContain(seed.other.handle);
      expect(html).not.toContain(seed.titles.other);
      expect(html).not.toContain(seed.titles.adminOnly);
    }
  });

  test('another community’s moderator gets only theirs', async ({ browser }) => {
    const page = await plain(browser);
    await signedIn(page, seed, seed.outsider.name);
    await page.goto(queue);
    await expect(section(page, `!${seed.other.handle}`)).toContainText('1 waiting');
    expect(await page.content()).not.toContain(`!${seed.community.handle}`);
  });

  test('an admin gets the admins’ own reports in one section with no community; hydrated, the page is accessible', async ({ page }) => {
    await gotoHydrated(page, '/auth/sign-in');
    await signIn(page, `@${seed.admin.name}`, seed.password);
    await landed(page, /\/auth\/two-factor/);
    await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(seed.admin.totpSecret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await landed(page, '/');
    await gotoHydrated(page, `${queue}?tab=admins&community=${seed.community.handle}`);
    const admins = section(page, 'People and admins-only reports');
    await expect(admins).toContainText('1 waiting');
    await expect(admins.locator('tbody tr', { hasText: 'Admins only. Open it to review.' })).toHaveCount(1);
    // The child-safety report is filed in the community, yet the community has no section for it here.
    await expect(section(page, `!${seed.community.handle}`)).toHaveCount(0);
    await gotoHydrated(page, `${queue}?community=${seed.community.handle}`);
    await expect(section(page, `!${seed.community.handle}`)).toContainText('5 waiting');
    await expectAccessible(page);
  });
});

test.describe('the gallery', () => {
  test.beforeEach(async ({ request }) => skipWithoutKit(request));
  test.setTimeout(240_000);
  for (const composition of ['queue-groups', 'queue-groups-closed'])
    test(`/kit/${composition}: every state, scheme and condition passes`, async ({ browser, baseURL }) => {
      const states = ['rest', 'hover', 'focus', 'pressed'];
      const checks = await galleryStates(browser, baseURL!, `/kit/${composition}`);
      expect([...new Set(checks.map(({ state }) => state))]).toEqual(states);
      expect(checks).toHaveLength(states.length * 2 * 4);
      expect(stateProblems(checks, { target: 44 })).toEqual([]);
    });
});
