import { expect, test, type Page } from '@playwright/test';
import { landed, signIn, signOut } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { choose, seed, type Seed } from './support.ts';

// A composer left open in one tab while another tab of the same browser changes who is signed in
// (shell/viewer-sync.ts reloads the tab's data when it is shown again): the words of the first
// person never reach the second person's form, their drafts or their sheet.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

let world: Seed;
test.beforeAll(() => {
  world = seed();
});

/** The tab coming back to the foreground (headless pages are always "visible", so hide it first). */
async function showAgain(page: Page): Promise<void> {
  await page.evaluate(() => {
    const set = (state: string) => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    set('hidden');
    set('visible');
  });
}

/** The actor id the browser's latest page load recorded (shell/viewer-sync.ts), once it differs from `not`. */
async function recordedViewer(page: Page, not?: string): Promise<string> {
  await expect
    .poll(async () => {
      const value = await page.evaluate(() => localStorage.getItem('pb-viewer'));
      return value !== null && value !== '' && value !== not;
    })
    .toBe(true);
  return (await page.evaluate(() => localStorage.getItem('pb-viewer')))!;
}

const draftsHolding = (page: Page, words: string) =>
  page.evaluate(
    (needle) =>
      Object.keys(localStorage).filter((name) => name.startsWith('peblish.draft:') && localStorage.getItem(name)?.includes(needle)),
    words,
  );

/**
 * Signs in as the poster in one tab, which `open` then puts the composer in with `words` typed;
 * a second tab of the same browser then signs out and signs in as the moderator, and the first
 * tab is shown again. Returns both tabs and the two actor ids.
 */
async function switchAccountBehind(page: Page, open: (tab: Page) => Promise<void>) {
  const { password, people } = world;
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${people.poster}`, password);
  await landed(page, '/');
  await open(page);
  const was = await recordedViewer(page);
  // Marks this document, so a reload would show.
  await page.evaluate(() => Object.assign(window, { sameDocument: true }));

  const other = await page.context().newPage();
  await gotoHydrated(other, '/');
  await signOut(other);
  await gotoHydrated(other, '/auth/sign-in');
  await signIn(other, `@${people.moderator}`, password);
  await landed(other, '/');
  const now = await recordedViewer(other, was);
  await showAgain(page);
  return { other, was, now };
}

test('the composer page shows the new person an empty form, and the saved draft of the first person stays theirs', async ({ page }) => {
  const words = 'Typed by the first person';
  const { other, was, now } = await switchAccountBehind(page, async (tab) => {
    await gotoHydrated(tab, '/submit');
    await choose(tab, world.communities.open.handle);
    await tab.getByLabel('Title').fill(words);
    await tab.getByRole('textbox', { name: 'Body', exact: true }).fill(`${words}, in the body`);
    await tab.getByRole('button', { name: 'Save draft' }).click();
    await expect(tab.getByRole('status')).toHaveText('Draft saved in this browser.');
  });

  // The same tab, now the second person's form: nothing typed, nothing chosen, no restored draft.
  await expect(page.getByText(`Posting as @${world.people.moderator}@`)).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Body', exact: true })).toHaveValue('');
  await expect(page.locator('input[name="community"]:checked')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('');
  expect(await page.evaluate(() => 'sameDocument' in window)).toBe(true);
  // The saved draft stays the first person's: it is under their key, and the second person's form did not restore it.
  expect(await draftsHolding(page, words)).toEqual([`peblish.draft:${was}:${world.communities.open.id}`]);
  expect(await page.evaluate((id) => Object.keys(localStorage).filter((name) => name.includes(id)), now)).toEqual([]);
  await other.close();
});

test('the sheet reloads for the new person: an empty form, and the first person words only in their own draft', async ({ page }) => {
  const words = 'Half a thought in the sheet';
  const sheet = (tab: Page) => tab.getByRole('dialog', { name: 'Create post' });
  const { other, was, now } = await switchAccountBehind(page, async (tab) => {
    await tab.getByRole('link', { name: 'Create post' }).click();
    await expect(sheet(tab).getByText(`Posting as @${world.people.poster}@`)).toBeVisible();
    await choose(sheet(tab), world.communities.open.handle);
    await sheet(tab).getByLabel('Title').fill(words);
    await sheet(tab).getByRole('textbox', { name: 'Body', exact: true }).fill(`${words}, again`);
  });

  // Still open, and now the second person's: their data, an empty form, no draft of theirs restored.
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByText(`Posting as @${world.people.moderator}@`)).toBeVisible();
  await expect(sheet(page).getByLabel('Title')).toHaveValue('');
  await expect(sheet(page).getByRole('textbox', { name: 'Body', exact: true })).toHaveValue('');
  await expect(sheet(page).locator('input[name="community"]:checked')).toHaveCount(0);
  await expect(sheet(page).getByRole('status')).toHaveText('');
  expect(await page.evaluate(() => 'sameDocument' in window)).toBe(true);
  // What the first person wrote waits in their own draft (an Escape would have kept it too), and nowhere the second can read.
  expect(await draftsHolding(page, words)).toEqual([`peblish.draft:${was}:${world.communities.open.id}`]);
  expect(await page.evaluate((id) => Object.keys(localStorage).filter((name) => name.includes(id)), now)).toEqual([]);
  await other.close();
});
