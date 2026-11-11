import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type Page, type Request } from '@playwright/test';
import { base32, freshTotp, landed, seed, signIn, unique } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The security page's request contract (PR #26) through the real page: every form's intent is
// its submit button's, which Enter presses, so Enter in a field sends that field's own form and
// nothing else, with scripts on (AuthForm's fetch) and off (a plain post). Each test has a person
// of its own, signed in twice, so a revoked session would show; and an address of its own
// (X-Forwarded-For, which the e2e server trusts), so its wrong passwords spend no other spec's budget.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

type Person = { name: string; email: string; password: string };
const newPassword = 'a second long passphrase';

/** A form post, not a server function call (those go to /_serverFn/). */
const isFormPost = (request: Request) => request.method() === 'POST' && !new URL(request.url()).pathname.startsWith('/_serverFn/');

/** A context of its own, signed in as `person`, with or without scripts. */
async function signedIn(browser: Browser, person: Person, options: { javaScriptEnabled: boolean; ip: string }): Promise<Page> {
  const context = await browser.newContext({
    javaScriptEnabled: options.javaScriptEnabled,
    extraHTTPHeaders: { 'x-forwarded-for': options.ip },
  });
  const page = await context.newPage();
  await page.goto('/auth/sign-in');
  if (options.javaScriptEnabled) await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await signIn(page, person.email, person.password);
  await page.waitForURL('/');
  return page;
}

/** Opens the security page as a new document, hydrated when scripts run. */
async function open(page: Page, scripts: boolean): Promise<void> {
  if (scripts) await gotoHydrated(page, '/settings/security');
  else await page.goto('/settings/security');
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
}

/** What the server says now, read from a fresh load: two-factor's status and how many sessions are signed in. */
async function serverState(page: Page, scripts: boolean) {
  await open(page, scripts);
  const status = page.getByRole('region', { name: 'Two-factor authentication' });
  return {
    twoFactor: (await status.getByText('On.', { exact: true }).count()) > 0 ? 'on' : 'off',
    sessions: await page.getByTestId('session').count(),
  };
}

/**
 * Presses Enter in the field labelled `field` of the form named `form` and answers with the
 * intent the post carried, after its answer arrived. Every post the page sends is kept in `posts`.
 */
async function enterIn(page: Page, form: string, field: string): Promise<string | null> {
  const sent = page.waitForRequest(isFormPost);
  await page.getByRole('form', { name: form }).getByLabel(field, { exact: true }).press('Enter');
  const request = await sent;
  await request.response();
  expect(new URL(request.url()).pathname).toBe('/settings/security');
  return new URLSearchParams(request.postData() ?? '').get('intent');
}

/** Every POST a page sends, as `path intent`. */
function recordPosts(page: Page): string[] {
  const posts: string[] = [];
  page.on('request', (request: Request) => {
    if (isFormPost(request))
      posts.push(`${new URL(request.url()).pathname} ${new URLSearchParams(request.postData() ?? '').get('intent')}`);
  });
  return posts;
}

const alertIn = (page: Page, form: string) => page.getByRole('form', { name: form }).getByRole('alert');

for (const scripts of [true, false]) {
  test(`Enter in each field sends only its own form, with scripts ${scripts ? 'on' : 'off'}`, async ({ browser }) => {
    test.setTimeout(150_000);
    const person = seed('e2e-person', unique(scripts ? 'enter_js' : 'enter_plain')) as Person;
    const ip = scripts ? '192.0.2.61' : '192.0.2.62';
    const page = await signedIn(browser, person, { javaScriptEnabled: scripts, ip });
    const other = await signedIn(browser, person, { javaScriptEnabled: true, ip });
    const posts = recordPosts(page);
    expect(await serverState(page, scripts)).toEqual({ twoFactor: 'off', sessions: 2 });

    // Two-factor off: the password form (intent "password") and the start form ("totp-start").
    const password = page.getByRole('form', { name: 'Password' });
    for (const field of ['Current password', 'New password']) {
      await password.getByLabel('Current password', { exact: true }).fill('not the password');
      await password.getByLabel('New password', { exact: true }).fill(newPassword);
      expect(await enterIn(page, 'Password', field)).toBe('password');
      await expect(alertIn(page, 'Password')).toHaveText('The password is wrong.');
      expect(await serverState(page, scripts)).toEqual({ twoFactor: 'off', sessions: 2 });
    }
    const start = page.getByRole('form', { name: 'Turn on' });
    await start.getByLabel('Confirm your password to start').fill('not the password');
    expect(await enterIn(page, 'Turn on', 'Confirm your password to start')).toBe('totp-start');
    await expect(alertIn(page, 'Turn on')).toHaveText('The password is wrong.');
    expect(await serverState(page, scripts)).toEqual({ twoFactor: 'off', sessions: 2 });
    await start.getByLabel('Confirm your password to start').fill(person.password);
    expect(await enterIn(page, 'Turn on', 'Confirm your password to start')).toBe('totp-start');
    await expect(page.getByTestId('totp-key')).toBeVisible();

    // A setup in progress: the code form ("totp-verify").
    const key = base32((await page.getByTestId('totp-key').textContent()) ?? '');
    const verify = page.getByRole('form', { name: 'Enter the 6 digit code' });
    await verify.getByLabel('Code', { exact: true }).fill('000000');
    expect(await enterIn(page, 'Enter the 6 digit code', 'Code')).toBe('totp-verify');
    await expect(alertIn(page, 'Enter the 6 digit code')).toHaveText('That code is wrong. Try the newest one.');
    expect(await serverState(page, scripts)).toEqual({ twoFactor: 'off', sessions: 2 });
    await page
      .getByRole('form', { name: 'Enter the 6 digit code' })
      .getByLabel('Code', { exact: true })
      .fill(await freshTotp(key));
    expect(await enterIn(page, 'Enter the 6 digit code', 'Code')).toBe('totp-verify');
    await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
    // Confirming signs every other session out (its own effect): sign the second one in again, with a code.
    expect(await serverState(page, scripts)).toEqual({ twoFactor: 'on', sessions: 1 });
    await other.goto('/settings/security');
    await landed(other, /\/auth\/sign-in\?redirect=/);
    await signIn(other, person.email, person.password);
    await landed(other, /\/auth\/two-factor/);
    await other.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(key));
    await other.getByRole('button', { name: 'Verify' }).click();
    await other.waitForURL((url) => !url.pathname.startsWith('/auth/'));

    // Two-factor on: the off form ("totp-off") with a wrong password changes nothing.
    expect(await serverState(page, scripts)).toEqual({ twoFactor: 'on', sessions: 2 });
    const off = page.getByRole('form', { name: 'Turn off' });
    await off.getByLabel('Password', { exact: true }).fill('not the password');
    expect(await enterIn(page, 'Turn off', 'Password')).toBe('totp-off');
    await expect(alertIn(page, 'Turn off')).toHaveText('The password is wrong.');
    expect(await serverState(page, scripts)).toEqual({ twoFactor: 'on', sessions: 2 });

    // The password changes from Enter in its own form, which signs the other session out (its
    // own effect) and leaves two-factor on.
    await password.getByLabel('Current password', { exact: true }).fill(person.password);
    await password.getByLabel('New password', { exact: true }).fill(newPassword);
    expect(await enterIn(page, 'Password', 'Current password')).toBe('password');
    await page.waitForURL(/\?saved=password$/);
    await expect(
      page.getByRole('region', { name: 'Password' }).getByText('Password changed. Other sessions are signed out.'),
    ).toBeVisible();
    expect(await serverState(page, scripts)).toEqual({ twoFactor: 'on', sessions: 1 });
    await other.goto('/settings/security');
    await landed(other, /\/auth\/sign-in\?redirect=/);

    // Two-factor turns off from Enter in its own form, with the new password.
    await page.getByRole('form', { name: 'Turn off' }).getByLabel('Password', { exact: true }).fill(newPassword);
    expect(await enterIn(page, 'Turn off', 'Password')).toBe('totp-off');
    await expect(page.getByRole('form', { name: 'Turn on' })).toBeVisible();
    expect(await serverState(page, scripts)).toEqual({ twoFactor: 'off', sessions: 1 });

    // Every post went to this page, none to account deletion or a revoke; the account is still there.
    expect(posts).toEqual([
      '/settings/security password',
      '/settings/security password',
      '/settings/security totp-start',
      '/settings/security totp-start',
      '/settings/security totp-verify',
      '/settings/security totp-verify',
      '/settings/security totp-off',
      '/settings/security password',
      '/settings/security totp-off',
    ]);
    const fresh = await signedIn(browser, { ...person, password: newPassword }, { javaScriptEnabled: true, ip });
    await gotoHydrated(fresh, '/settings/account');
    await expect(fresh.getByText(`@${person.name}@`)).toBeVisible();
    for (const opened of [page, other, fresh]) await opened.context().close();
  });
}

test('the recovery code download holds exactly the codes on the page, and its object URL is revoked', async ({ browser }) => {
  test.setTimeout(90_000);
  const person = seed('e2e-person', unique('codes')) as Person;
  const page = await signedIn(browser, person, { javaScriptEnabled: true, ip: '192.0.2.63' });
  await open(page, true);
  await page.getByLabel('Confirm your password to start').fill(person.password);
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByTestId('totp-key')).toBeVisible();
  const key = base32((await page.getByTestId('totp-key').textContent()) ?? '');
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(key));
  await page.getByRole('button', { name: 'Verify and turn on' }).click();
  await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  const codes = await page.getByTestId('recovery-codes').locator('li').allTextContents();
  expect(codes).toHaveLength(10);

  // Spy on the object URLs the page makes and revokes, keeping what they do.
  await page.evaluate(() => {
    const spied = { created: [] as string[], revoked: [] as string[] };
    Object.assign(window, { spied });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      const url = create(blob);
      spied.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      spied.revoked.push(url);
      revoke(url);
    };
  });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .txt' }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(`${new URL(process.env.PUBLIC_ORIGIN ?? 'https://disc.peblish.test').host}-recovery-codes.txt`);
  const text = await readFile(await download.path(), 'utf8');
  const host = download.suggestedFilename().replace(/-recovery-codes\.txt$/, '');
  expect(text).toBe(`${host} recovery codes\n\n${codes.join('\n')}\n`);
  const spied = await page.evaluate(() => (window as unknown as { spied: { created: string[]; revoked: string[] } }).spied);
  expect(spied.created).toHaveLength(1);
  expect(spied.revoked).toEqual(spied.created);
  await page.context().close();
});
