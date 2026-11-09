import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectAccessible } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import { community, seed, signedIn, type Seed } from './support.ts';

// The shell's "Create post" opens the composer as a bottom sheet over the page it is on: the
// page stays mounted underneath, and the sheet's code is loaded only then.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let world: Seed;
let poster: BrowserContext;

test.beforeAll(async ({ browser, baseURL }) => {
  world = seed();
  poster = await signedIn(browser, baseURL!, world.people.poster, world.password);
});
test.afterAll(async () => {
  await poster.close();
});

const create = (page: Page) => page.getByRole('link', { name: 'Create post' });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Create post' });

test('the sheet slides up over the page, which stays underneath, and has no axe violations', async () => {
  const page = await poster.newPage();
  const log = recordConsole(page);
  await gotoHydrated(page, '/');
  const main = page.locator('#pb-main main');
  await expect(main).toBeAttached();
  await expect(sheet(page)).toHaveCount(0);
  await create(page).click();
  await expect(sheet(page)).toBeVisible();
  // Still the same page: the URL did not change and its content is still mounted.
  await expect(page).toHaveURL('/');
  await expect(main).toBeAttached();
  // The panel is pinned to the bottom edge and covers most of the viewport.
  const viewport = page.viewportSize()!;
  const bottom = async () => {
    const box = await sheet(page).boundingBox();
    return box!.y + box!.height;
  };
  // It slides in for a fraction of a second; then it rests on the bottom edge.
  await expect.poll(bottom).toBeCloseTo(viewport.height, 0);
  expect((await sheet(page).boundingBox())!.height).toBeGreaterThan(viewport.height * 0.7);
  await expect(sheet(page).getByLabel('Title')).toBeVisible();
  await expectAccessible(page);
  expect(log.hydrationProblems()).toEqual([]);
  await page.close();
});

test('Escape closes the sheet, returns focus, and keeps what was written as a draft', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/');
  await create(page).click();
  await sheet(page).getByLabel('Title').fill('Left unfinished');
  await sheet(page).getByRole('textbox', { name: 'Body', exact: true }).fill('Half a thought');
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(create(page)).toBeFocused();
  await create(page).click();
  await expect(sheet(page).getByLabel('Title')).toHaveValue('Left unfinished');
  await expect(sheet(page).getByRole('textbox', { name: 'Body', exact: true })).toHaveValue('Half a thought');
  await expect(sheet(page).getByRole('status')).toHaveText('Your saved draft for this community is back.');
  // Discard closes it for good and removes the draft.
  await sheet(page).getByRole('button', { name: 'Discard' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await create(page).click();
  await expect(sheet(page).getByLabel('Title')).toHaveValue('');
  await page.close();
});

test('posting from the sheet closes it and opens the new post', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/');
  await create(page).click();
  await community(sheet(page), world.communities.open.handle).check();
  await sheet(page).getByLabel('Title').fill('Posted from the sheet');
  await sheet(page).getByRole('textbox', { name: 'Body', exact: true }).fill('Written over the feed.');
  await sheet(page).getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Posted from the sheet');
  await expect(sheet(page)).toHaveCount(0);
  await page.close();
});

test('a modified click and the composer page itself keep the plain link', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/');
  const opened = page.context().waitForEvent('page');
  await create(page).click({ modifiers: ['ControlOrMeta'] });
  const tab = await opened;
  await expect(tab).toHaveURL(/\/submit$/);
  await expect(sheet(page)).toHaveCount(0);
  await tab.close();
  await gotoHydrated(page, '/submit');
  await create(page).click();
  await expect(sheet(page)).toHaveCount(0);
  await page.close();
});

test('the sheet starts in the community whose page is open', async () => {
  const page = await poster.newPage();
  // No page for /c/<handle> exists yet; the sheet reads the path, so any answer will do.
  await page.goto(`/c/${world.communities.open.handle}`, { waitUntil: 'commit' });
  await page.locator('html[data-shell-hydrated="1"]').waitFor({ state: 'attached' });
  await create(page).click();
  await expect(sheet(page).locator('input[name="community"]:checked')).toHaveValue(world.communities.open.id);
  await expect(sheet(page).getByRole('complementary', { name: 'Community rules' })).toContainText('Be civil');
  await page.close();
});
