import { expect, test, type Browser, type Page } from '@playwright/test';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import {
  base32,
  expectAccessible,
  freshTotp,
  landed,
  mailCount,
  mailedLink,
  seed,
  signIn,
  signOut,
  unique,
  type Admin,
} from './support.ts';

// Lane A end to end, on the built server and the lane database: the admin invites, a person
// signs up with the code and a date of birth, verifies by mail, turns on TOTP and signs in
// with a code and with a recovery code, revokes a session, resets the password and deletes
// the account. The steps share one person, so they run in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let admin: Admin;
test.beforeAll(() => {
  admin = seed('e2e-admin') as Admin;
});
const person = { name: unique('mira'), password: 'my first long passphrase', newPassword: 'a second long passphrase' };
const email = `${person.name}@example.test`;
let inviteCode = '';
let totpKey: Uint8Array = new Uint8Array();
let recoveryCodes: string[] = [];

async function freshPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}

/** The two-factor step with one of the recovery codes (each works once). */
async function withRecoveryCode(page: Page, code: string | undefined): Promise<void> {
  await landed(page, /\/auth\/two-factor/);
  await page.getByRole('link', { name: 'Use a recovery code' }).click();
  await landed(page, /recovery=yes/);
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(code ?? '');
  await page.getByRole('button', { name: 'Verify' }).click();
  await landed(page, '/');
}

test('the admin signs in with a TOTP code and creates an invite', async ({ page }) => {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${admin.name}`, admin.password);
  await landed(page, /\/auth\/two-factor/);
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(admin.totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await landed(page, '/');

  await gotoHydrated(page, '/admin/registration');
  await page.getByLabel('Label').fill(`e2e ${person.name}`);
  await page.getByLabel('Max uses').fill('2');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('invite-code')).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  inviteCode = (await page.getByTestId('invite-code').textContent()) ?? '';
  expect(inviteCode).toMatch(/^PB-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  const row = page.getByTestId('invite-row').filter({ hasText: `e2e ${person.name}` });
  await expect(row).toContainText('0 / 2');
  await expect(row).toContainText('Active');
  await expectAccessible(page);
  // Shown once: a reload, or a URL naming the code, shows no code.
  await gotoHydrated(page, '/admin/registration');
  await expect(page.getByTestId('invite-code')).toHaveCount(0);
  await gotoHydrated(page, `/admin/registration?created=${inviteCode}`);
  await expect(page.getByTestId('invite-code')).toHaveCount(0);
});

test('the invite link leads to sign-up; the account needs its email verified', async ({ page, baseURL }) => {
  await gotoHydrated(page, `/invite/${inviteCode}`);
  await expect(page.getByRole('heading', { name: /You're invited to/ })).toBeVisible();
  await expect(page.getByText(`@${admin.name}@`)).toBeVisible();
  await page.getByRole('button', { name: 'Continue to sign up' }).click();
  await landed(page, /\/auth\/sign-up\?invite=/);
  await expect(page.getByLabel('Invite code')).toHaveValue(inviteCode);
  await expect(page.getByText(/Valid\. Invited by/)).toBeVisible();

  await page.getByLabel('Username').fill(person.name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByLabel('Day').fill('14');
  await page.getByLabel('Month').selectOption({ label: 'March' });
  await page.getByLabel('Year').fill('1994');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await landed(page, '/auth/verify');
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByText('Pending')).toBeVisible();

  await page.goto(await mailedLink(email, baseURL!));
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Link already used' })).toBeVisible();
});

test('TOTP turns on with a code and shows the recovery codes once', async ({ page }) => {
  const log = recordConsole(page);
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, person.name, person.password);
  await landed(page, '/');
  await gotoHydrated(page, '/settings/security');
  await page.getByLabel('Confirm your password to start').fill(person.password);
  await page.getByRole('button', { name: 'Turn on' }).click();
  await landed(page, '/settings/security');
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  await expectAccessible(page);
  totpKey = base32((await page.getByTestId('totp-key').textContent()) ?? '');
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(totpKey));
  await page.getByRole('button', { name: 'Verify and turn on' }).click();
  await landed(page, '/settings/security');
  await expect(page.getByText('On.')).toBeVisible();
  recoveryCodes = await page.getByTestId('recovery-codes').locator('li').allTextContents();
  expect(recoveryCodes).toHaveLength(10);
  await page.reload();
  await expect(page.getByTestId('recovery-codes')).toHaveCount(0);
  expect(log.hydrationProblems()).toEqual([]);
  await signOut(page);
});

test('signing in asks for the code, or once for a recovery code', async ({ page }) => {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, email, person.password);
  await landed(page, /\/auth\/two-factor/);
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toHaveText('That code is wrong. Try the newest one.');
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(totpKey));
  await page.getByRole('button', { name: 'Verify' }).click();
  await landed(page, '/');
  await signOut(page);

  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, email, person.password);
  await withRecoveryCode(page, recoveryCodes[0]);
  await gotoHydrated(page, '/settings/security');
  await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
});

test('a session signed in elsewhere can be revoked', async ({ page, browser }) => {
  const other = await freshPage(browser);
  await gotoHydrated(other, '/auth/sign-in');
  await signIn(other, email, person.password);
  await withRecoveryCode(other, recoveryCodes[1]);

  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, email, person.password);
  await withRecoveryCode(page, recoveryCodes[2]);
  await gotoHydrated(page, '/settings/security');
  const sessions = page.getByTestId('session');
  const before = await sessions.count();
  expect(before).toBeGreaterThanOrEqual(2);
  await expect(sessions.filter({ hasText: 'THIS DEVICE' })).toHaveCount(1);
  await sessions.filter({ hasNotText: 'THIS DEVICE' }).first().getByRole('button', { name: 'Revoke' }).click();
  await landed(page, '/settings/security');
  await expect(sessions).toHaveCount(before - 1);
  await page.getByRole('button', { name: 'Sign out all other sessions' }).click();
  await landed(page, '/settings/security');
  await expect(sessions).toHaveCount(1);

  await other.goto('/settings/security');
  await landed(other, /\/auth\/sign-in\?redirect=/);
  await signOut(page);
});

test('a password reset by mail replaces the password', async ({ page, baseURL }) => {
  const mails = await mailCount(email);
  await gotoHydrated(page, '/auth/reset');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send the link' }).click();
  await landed(page, /sent=yes/);
  await page.goto(await mailedLink(email, baseURL!, mails));
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await page.getByLabel('New password', { exact: true }).fill(person.newPassword);
  await page.getByRole('button', { name: 'Change password' }).click();
  await landed(page, /\/auth\/sign-in\?reset=done/);
  await signIn(page, email, person.password);
  await expect(page.getByRole('alert')).toHaveText('Email or password is wrong.');
  await signIn(page, email, person.newPassword);
  await landed(page, /\/auth\/two-factor/);
});

test('deleting the account signs out, blocks sign-in, and leaves the ledger row and event', async ({ page }) => {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, email, person.newPassword);
  await withRecoveryCode(page, recoveryCodes[3]);
  await gotoHydrated(page, '/settings/account');
  await page.getByLabel('Type your username to confirm').fill(person.name);
  await page.getByLabel('Password', { exact: true }).fill(person.newPassword);
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await page.waitForURL('/');
  await gotoHydrated(page, '/settings/account');
  await landed(page, /\/auth\/sign-in/);
  await signIn(page, email, person.newPassword);
  await expect(page.getByRole('alert')).toHaveText('Email or password is wrong.');
  expect(seed('deleted', person.name)).toEqual({ deleted: true, login: false, ledgerRows: 1, deletedEvents: 1 });
});

test('an under-16 date of birth blocks sign-up from this browser for 24 hours', async ({ page, context }) => {
  await gotoHydrated(page, `/auth/sign-up?invite=${inviteCode}`);
  const year = new Date().getUTCFullYear() - 12;
  await page.getByLabel('Username').fill(unique('kid'));
  await page.getByLabel('Email').fill(`${unique('kid')}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a long enough passphrase');
  await page.getByLabel('Day').fill('1');
  await page.getByLabel('Month').selectOption({ label: 'January' });
  await page.getByLabel('Year').fill(String(year));
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await landed(page, '/auth/sign-up');
  await expect(page.getByRole('heading', { name: "You can't create an account" })).toBeVisible();
  const gate = (await context.cookies()).find(({ name }) => name === 'peblish.age_gate');
  expect(gate?.httpOnly).toBe(true);
  expect((gate?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(24 * 3600 - 60);
  // A retry, even with a new invite link, still meets the block.
  await gotoHydrated(page, `/auth/sign-up?invite=${inviteCode}`);
  await expect(page.getByRole('heading', { name: "You can't create an account" })).toBeVisible();
  // The invite was not used by the blocked attempt (one use left of two).
  await gotoHydrated(page, `/invite/${inviteCode}`);
  await expect(page.getByText(/1 use left/)).toBeVisible();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('sign-in still works by plain form posts, errors included', async ({ page }) => {
    await page.goto('/auth/sign-in');
    await signIn(page, 'nobody@example.test', 'not the password');
    await page.waitForURL(/error=credentials\.invalid/);
    await expect(page.getByRole('alert')).toHaveText('Email or password is wrong.');
    await signIn(page, `@${admin.name}`, admin.password);
    await page.waitForURL(/\/auth\/two-factor/);
    await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(admin.totpSecret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL('/');
  });
});
