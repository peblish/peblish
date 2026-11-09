import { expect, test, type Page } from '@playwright/test';
import type { Admin } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { seedAdm, signInAdmin } from './support.ts';

// The kill switches on the admin Settings tab (lane ADM). Pausing registration, posting, remote
// media, delivery or the inbox stops what other specs do, so these cases run in the serial
// project, after the parallel one, with their own admin (the server takes a TOTP code once per
// 30-second step, and the parallel admin specs sign theirs in moments before).
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let page: Page;
test.beforeAll(async ({ browser }) => {
  const { admin } = seedAdm('e2e-switches') as { admin: Admin };
  page = await (await browser.newContext()).newPage();
  await signInAdmin(page, admin);
});
test.afterAll(async () => page.context().close());

/** What the modlog recorded for settings so far, as the seed reads it. */
const settingsLog = () => seedAdm('settings-log') as { changes: Record<string, { before: unknown; after: unknown }>; public: boolean }[];
// Core's kill-switches.test.ts flips all six switches through the real mutation and its readers.
const switches = [
  ['registration.enabled', 'Registration', 'Pause registration', 'Resume registration'],
  ['posting.enabled', 'Posting', 'Pause posting', 'Resume posting'],
  ['remote_media.enabled', 'Remote media', 'Pause remote media', 'Resume remote media'],
  ['delivery.enabled', 'Outgoing delivery', 'Pause delivery', 'Resume delivery'],
] as const;

for (const [key, label, pause, resume] of switches) {
  test(`${label}: pausing is marked, resuming restores it, and both are logged`, async () => {
    await gotoHydrated(page, '/admin/settings');
    const row = page.locator(`[data-switch="${key}"]`);
    // Look only at this switch's rows: the other admin specs save settings too.
    const own = () => settingsLog().filter(({ changes }) => key in changes);
    const before = own().length;
    await row.getByRole('button', { name: pause }).click();
    try {
      await page.waitForURL(/saved=/);
      await expect(page.locator(`[data-switch="${key}"] [role="status"]`)).toHaveText('Paused');
    } finally {
      // Other specs share this database: put the switch back before anything else.
      if (await page.locator(`[data-switch="${key}"]`).getByRole('button', { name: resume }).isVisible())
        await page.locator(`[data-switch="${key}"]`).getByRole('button', { name: resume }).click();
    }
    await page.waitForURL(/saved=/);
    await expect(page.locator(`[data-switch="${key}"]`).getByRole('button', { name: pause })).toBeVisible();
    const log = own().slice(before);
    expect(log).toEqual([
      { changes: { [key]: { before: true, after: false } }, public: false },
      { changes: { [key]: { before: false, after: true } }, public: false },
    ]);
  });
}

test('pausing the inbox makes it answer 503 with Retry-After, and it goes back to 401 for an unsigned post; both flips are logged', async ({
  request,
}) => {
  const post = () => request.post('/inbox', { data: '{}', headers: { 'content-type': 'application/activity+json' } });
  const own = () => settingsLog().filter(({ changes }) => 'inbox.enabled' in changes);
  const before = own().length;
  expect((await post()).status()).toBe(401);
  await gotoHydrated(page, '/admin/settings');
  await page.locator('[data-switch="inbox.enabled"]').getByRole('button', { name: 'Pause inbox' }).click();
  await page.waitForURL(/saved=/);
  try {
    const paused = await post();
    expect([paused.status(), Number(paused.headers()['retry-after']) > 0]).toEqual([503, true]);
  } finally {
    await page.locator('[data-switch="inbox.enabled"]').getByRole('button', { name: 'Resume inbox' }).click();
    await page.waitForURL(/saved=/);
  }
  expect((await post()).status()).toBe(401);
  expect(own().slice(before)).toEqual([
    { changes: { 'inbox.enabled': { before: true, after: false } }, public: false },
    { changes: { 'inbox.enabled': { before: false, after: true } }, public: false },
  ]);
});
