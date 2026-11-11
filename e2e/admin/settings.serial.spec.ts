import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import type { Admin } from '../auth/support.ts';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import { seedAdm, signInAdmin } from './support.ts';

// The admin Settings and Registration tabs on the built server and the lane database: saving, the brand, the kill
// switches, invites, and who may see the pages. The steps share one signed-in admin, so they run in order.
// It saves site settings every page reads, so it is a serial spec (e2e/playwright.config.ts).
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
    ['delivery.enabled', 'Sending and fetching'],
  ] as const) {
    const row = page.locator(`[data-switch="${key}"]`);
    await expect(row.getByText(label, { exact: true })).toBeVisible();
    await expect(row.getByRole('button')).toHaveCount(1);
    // What pausing does is the button's description.
    await expect(row.getByRole('button')).toHaveAccessibleDescription(/\S/);
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
  for (const path of [
    '/admin/settings',
    '/admin/pages',
    '/admin/pages/rules/en',
    '/admin/reports',
    '/admin/bans',
    '/admin/peers',
    '/admin/media',
    '/admin/registration',
  ]) {
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

/** A context signed in as this spec's admin: scripts off, another language or a phone screen. */
const asAdmin = async (browser: Browser, options: BrowserContextOptions = {}) =>
  browser.newContext({ ...options, storageState: await page.context().storageState() });
const switchKeys = [
  'registration.enabled',
  'posting.enabled',
  'uploads.enabled',
  'remote_media.enabled',
  'inbox.enabled',
  'delivery.enabled',
];
/** Each switch row's badge and button, in page order. */
const switchStates = (on: Page) =>
  on.locator('[data-switch]').evaluateAll((rows) => rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? ''));

test('Enter in a settings field saves the form and never flips a kill switch', async () => {
  for (const label of ['Site name', 'Account cap']) {
    await gotoHydrated(page, '/admin/settings');
    const before = await switchStates(page);
    await page.getByLabel(label, { exact: true }).press('Enter');
    await page.waitForURL(/saved=/);
    expect(await switchStates(page)).toEqual(before);
  }
});

test('a refused switch post changes nothing, and every row keeps showing its stored state', async () => {
  for (const key of switchKeys) {
    await gotoHydrated(page, '/admin/settings');
    const row = page.locator(`[data-switch="${key}"]`);
    const before = await switchStates(page);
    // A state the server refuses (a hand-made or stale post).
    await row.locator('input[name="state"]').evaluate((input: HTMLInputElement) => (input.value = 'maybe'));
    await row.getByRole('button').click();
    await page.waitForURL(/error=/);
    await expect(page.getByRole('alert').filter({ hasText: 'Nothing was saved.' })).toBeVisible();
    expect(await switchStates(page)).toEqual(before);
    await expect(
      page.locator(`[data-switch="${key}"]`).getByText(key === 'uploads.enabled' ? 'Paused' : 'On', { exact: true }),
    ).toBeVisible();
  }
});

test('with scripts off the settings form posts plainly and saves', async ({ browser }) => {
  const context = await asAdmin(browser, { javaScriptEnabled: false });
  const plain = await context.newPage();
  await plain.goto('/admin/settings');
  await plain.getByLabel('Description').fill('Saved without scripts.');
  await plain.getByRole('button', { name: 'Save changes' }).click();
  await plain.waitForURL(/saved=/);
  await expect(plain.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expect(plain.getByLabel('Description')).toHaveValue('Saved without scripts.');
  await context.close();
});

test('the registration meter reads the same on the server and in the browser, in English and German', async ({ browser }) => {
  for (const [locale, name] of [
    ['en-US', /^Beta cap \d+ \/ [\d,]+ accounts$/],
    ['de-DE', /^Beta-Grenze \d+ \/ [\d.]+ Konten$/],
  ] as const) {
    const context = await asAdmin(browser, { locale });
    const reader = await context.newPage();
    const console = recordConsole(reader);
    await gotoHydrated(reader, '/admin/registration');
    // The default cap is positive, so the meter shows.
    await expect(reader.getByRole('meter')).toHaveAccessibleName(name);
    await expectAccessible(reader);
    expect(console.hydrationProblems()).toEqual([]);
    await context.close();
  }
});

test('with scripts off an invite is created and revoked by plain posts', async ({ browser }) => {
  const context = await asAdmin(browser, { javaScriptEnabled: false });
  const plain = await context.newPage();
  await plain.goto('/admin/registration');
  const label = `plain ${Date.now()}`;
  await plain.getByLabel('Label').fill(label);
  await plain.getByRole('button', { name: 'Create' }).click();
  await expect(plain.getByTestId('invite-code')).toBeVisible();
  const row = () => plain.getByRole('row').filter({ hasText: label });
  await expect(row()).toContainText('Active');
  await row().getByRole('button', { name: 'Revoke' }).click();
  await expect(plain.getByTestId('invite-code')).toHaveCount(0);
  await expect(row()).toContainText('Revoked');
  await expect(row().getByRole('button', { name: 'Revoke' })).toHaveCount(0);
  await context.close();
});

test('a long invite label at phone width scrolls inside the table, never the page', async ({ browser }) => {
  const context = await asAdmin(browser, { viewport: { width: 375, height: 800 } });
  const phone = await context.newPage();
  await gotoHydrated(phone, '/admin/registration');
  const label = `Invite-for-the-organisers-of-the-very-long-named-regional-community-group-${Date.now()}`;
  await phone.getByLabel('Label').fill(label);
  await phone.getByRole('button', { name: 'Create' }).click();
  await expect(phone.getByTestId('invite-code')).toBeVisible();
  await expect(phone.getByRole('row').filter({ hasText: label })).toBeAttached();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
  await context.close();
});
