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

test('a visitor signed out is sent to sign in, and a member without the admin role is told no', async ({ browser }) => {
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto('/admin/settings');
  await expect(visitor).toHaveURL(/\/auth\/sign-in\?redirect=%2Fadmin%2Fsettings/);
  await signIn(visitor, `@${member.name}`, member.password);
  await landed(visitor, '/admin/settings');
  await expect(visitor.getByRole('alert')).toHaveText('Only site admins can use this page.');
  await expect(visitor.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  // Each admin tab answers its denial as a 403, as the report queue does.
  for (const path of ['/admin/settings', '/admin/pages', '/admin/pages/rules/en', '/admin/bans', '/admin/peers']) {
    const response = await visitor.goto(path);
    expect(response?.status(), path).toBe(403);
    await expect(visitor.getByRole('alert'), path).toBeVisible();
  }
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
