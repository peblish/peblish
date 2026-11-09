import { expect, test, type Page } from '@playwright/test';
import type { Admin } from '../auth/support.ts';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import { seedAdm, signInAdmin } from './support.ts';

// The admin Settings tab on the built server and the lane database: saving, the brand, the kill
// switches, and who may see the page. The steps share one signed-in admin, so they run in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let admin: Admin;
let member: { name: string; password: string };
let page: Page;
test.beforeAll(async ({ browser }) => {
  ({ admin, member } = seedAdm('e2e') as { admin: Admin; member: { name: string; password: string } });
  page = await (await browser.newContext()).newPage();
  await signInAdmin(page, admin);
});
test.afterAll(async () => page.context().close());

test('the settings page loads for an admin, in the shell, with no hydration problems', async () => {
  const console = recordConsole(page);
  await gotoHydrated(page, '/admin/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Settings' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByText(/\d+ of \d+ accounts used/)).toBeVisible();
  await expectAccessible(page);
  expect(console.hydrationProblems()).toEqual([]);
});

test('the saved name is the sidebar brand and the title suffix, and the software name appears nowhere', async () => {
  await gotoHydrated(page, '/admin/settings');
  await page.getByLabel('Site name').fill('Test Feddit');
  await page.getByLabel('Description').fill('A test instance.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(/saved=/);
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expect(page.locator('.pb-brand')).toHaveText('Test Feddit');
  await expect(page).toHaveTitle(/· Test Feddit$/);
  expect(await page.locator('.pb-brand').textContent()).not.toMatch(/peblish/i);
  await expect(page.getByLabel('Site name')).toHaveValue('Test Feddit');
});

test('a bad value saves nothing and marks its field', async () => {
  await gotoHydrated(page, '/admin/settings');
  await page.getByLabel('Contact email').fill('not-an-email');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(/error=settings.invalid&field=contact.email/);
  await expect(page.getByRole('alert').filter({ hasText: 'Nothing was saved.' })).toBeVisible();
  await expect(page.getByLabel('Contact email')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Check this value and try again.')).toBeVisible();
  await expect(page.getByLabel('Site name')).toHaveValue('Test Feddit');
});

/** What the modlog recorded for settings so far, as the seed reads it. */
const settingsLog = () => seedAdm('settings-log') as { changes: Record<string, { before: unknown; after: unknown }>; public: boolean }[];
// Every spec file runs side by side on one database, and these switches stop what other specs do
// (sign-up, posting, remote images). So pausing them in a default run would break a spec that
// happens to act at that moment; they flip only when the admin specs run alone:
//   PEBLISH_E2E_FLIP_ALL=1 pnpm e2e e2e/admin --workers=1
// Outgoing delivery has no other spec, and the inbox is flipped by its own short test below.
// Core's kill-switches.test.ts flips all six through the real mutation and its readers.
const flipAll = process.env.PEBLISH_E2E_FLIP_ALL === '1';
const switches = [
  ['registration.enabled', 'Registration', 'Pause registration', 'Resume registration', true],
  ['posting.enabled', 'Posting', 'Pause posting', 'Resume posting', true],
  ['remote_media.enabled', 'Remote media', 'Pause remote media', 'Resume remote media', true],
  ['delivery.enabled', 'Outgoing delivery', 'Pause delivery', 'Resume delivery', false],
] as const;

for (const [key, label, pause, resume, shared] of switches) {
  test(`${label}: pausing is marked, resuming restores it, and both are logged`, async () => {
    test.skip(shared && !flipAll, 'stops other specs: set PEBLISH_E2E_FLIP_ALL=1 and run the admin specs alone');
    await gotoHydrated(page, '/admin/settings');
    const row = page.locator(`[data-switch="${key}"]`);
    // The Pages spec saves settings too, side by side: look only at this switch's rows.
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

test('every kill switch is a row with its state, what pausing does and one button', async () => {
  await gotoHydrated(page, '/admin/settings');
  for (const [key, label] of [
    ['registration.enabled', 'Registration'],
    ['posting.enabled', 'Posting'],
    ['uploads.enabled', 'Image uploads'],
    ['remote_media.enabled', 'Remote media'],
    ['inbox.enabled', 'Inbox'],
    ['delivery.enabled', 'Outgoing delivery'],
  ] as const) {
    const row = page.locator(`[data-switch="${key}"]`);
    await expect(row.getByText(label, { exact: true })).toBeVisible();
    await expect(row.locator('.hint')).toContainText(/\S/);
    await expect(row.getByRole('button')).toHaveCount(1);
  }
});

test('uploads are off until scanning is live: the row says so and offers to turn them on, nothing more', async () => {
  await gotoHydrated(page, '/admin/settings');
  const row = page.locator('[data-switch="uploads.enabled"]');
  await expect(row).toContainText('Leave off until scanning is live.');
  await expect(row.getByRole('status')).toHaveText('Paused');
  await expect(row.getByRole('button', { name: 'Turn uploads on' })).toBeVisible();
});

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

test('a visitor signed out is sent to sign in, and a member without the admin role is told no', async ({ browser }) => {
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto('/admin/settings');
  await expect(visitor).toHaveURL(/\/auth\/sign-in\?redirect=%2Fadmin%2Fsettings/);
  await signIn(visitor, `@${member.name}`, member.password);
  await landed(visitor, '/admin/settings');
  await expect(visitor.getByRole('alert')).toHaveText('Only site admins can use this page.');
  await expect(visitor.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await visitor.context().close();
});

test('the settings page is German for a German browser, and passes the same checks', async ({ browser }) => {
  const german = await browser.newContext({ locale: 'de-DE', storageState: await page.context().storageState() });
  const de = await german.newPage();
  const console = recordConsole(de);
  await gotoHydrated(de, '/admin/settings');
  await expect(de.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
  await expect(de.getByRole('button', { name: 'Änderungen speichern' })).toBeVisible();
  await expectAccessible(de);
  expect(console.hydrationProblems()).toEqual([]);
  await german.close();
});
