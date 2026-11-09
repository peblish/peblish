import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { landed, signIn, signOut } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// A tab keeps the root loader's data for good, so one left open while another tab changes who
// the browser is signed in as must catch up when it is shown again (shell/viewer-sync.ts).
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

const seed = () =>
  JSON.parse(execFileSync('node', ['e2e/shell/seed.ts'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' })) as {
    password: string;
    people: [string, string];
  };

/** What the browser does when the person comes back to the tab (headless pages are always "visible", so hide it first). */
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

/**
 * Waits until `page` has recorded `viewer` (an effect that runs after hydration, a moment after
 * the navigation that shows it has finished), so the stale tab is not shown again before the
 * browser's latest viewer is written.
 */
const recorded = (page: Page, viewer: (value: string | null) => boolean) =>
  expect.poll(async () => viewer(await page.evaluate(() => localStorage.getItem('pb-viewer')))).toBe(true);

test('a tab shown again after another tab signed in, changed account or signed out shows the current viewer', async ({
  browser,
  baseURL,
}) => {
  const { password, people } = seed();
  const context = await browser.newContext({ baseURL });
  try {
    const stale = await context.newPage();
    await gotoHydrated(stale, '/');
    const banner = stale.getByRole('banner');
    await expect(banner.getByRole('link', { name: 'Sign in' })).toBeVisible();
    // Marks this document, so a reload would show.
    await stale.evaluate(() => Object.assign(window, { sameDocument: true }));

    // Another tab signs in as the first person.
    const other = await context.newPage();
    await gotoHydrated(other, '/auth/sign-in');
    await signIn(other, `@${people[0]}`, password);
    await landed(other, '/');
    await recorded(other, (value) => !!value);
    const first = await other.evaluate(() => localStorage.getItem('pb-viewer'));

    // The stale tab still shows the signed-out viewer until it is shown again.
    await expect(banner.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await showAgain(stale);
    await expect(banner.getByText(people[0])).toBeAttached();
    await expect(banner.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
    expect(await stale.evaluate(() => 'sameDocument' in window)).toBe(true);

    // The other tab switches account.
    await signOut(other);
    await gotoHydrated(other, '/auth/sign-in');
    await signIn(other, `@${people[1]}`, password);
    await landed(other, '/');
    await recorded(other, (value) => !!value && value !== first);
    await showAgain(stale);
    await expect(banner.getByText(people[1])).toBeAttached();
    await expect(banner.getByText(people[0])).toHaveCount(0);

    // And signs out: the stale tab goes back to the signed-out viewer.
    await signOut(other);
    await recorded(other, (value) => value === '');
    await showAgain(stale);
    await expect(banner.getByRole('link', { name: 'Sign in' })).toBeVisible();
    expect(await stale.evaluate(() => 'sameDocument' in window)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a tab shown again with nobody changed asks the server for nothing', async ({ page }) => {
  await gotoHydrated(page, '/');
  const calls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/_serverFn/')) calls.push(request.url());
  });
  await showAgain(page);
  await page.waitForTimeout(500);
  expect(calls).toEqual([]);
});
