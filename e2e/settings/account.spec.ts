import { expect, test } from '@playwright/test';
import { seed, signIn, unique } from '../auth/support.ts';

// Account deletion refused for a wrong password, through the real page, with scripts on (the
// enhanced form keeps what was typed) and off (a plain post, answered 303 with ?error=). The
// account stays: the page still loads signed in and the person can still sign in elsewhere.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

type Person = { name: string; email: string; password: string };

for (const scripts of [true, false]) {
  test(`a deletion with the wrong password is refused and leaves the account, with scripts ${scripts ? 'on' : 'off'}`, async ({
    browser,
  }) => {
    const person = seed('e2e-person', unique(scripts ? 'keep_js' : 'keep_plain')) as Person;
    // An address of its own, so this wrong password spends no other spec's budget (the e2e server trusts X-Forwarded-For).
    const extraHTTPHeaders = { 'x-forwarded-for': scripts ? '192.0.2.71' : '192.0.2.72' };
    const context = await browser.newContext({ javaScriptEnabled: scripts, extraHTTPHeaders });
    const page = await context.newPage();
    const hydrated = () => (scripts ? page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' }) : Promise.resolve());
    await page.goto('/auth/sign-in');
    await hydrated();
    await signIn(page, person.email, person.password);
    await page.waitForURL('/');

    await page.goto('/settings/account');
    await hydrated();
    const form = page.getByRole('form', { name: 'Delete account' });
    await form.getByLabel('Type your username to confirm').fill(person.name);
    await form.getByLabel('Password', { exact: true }).fill('not the password');
    const posted = page.waitForResponse(
      (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/settings/account',
    );
    await form.getByRole('button', { name: 'Delete my account' }).click();
    const answer = await posted;
    expect(new URLSearchParams(answer.request().postData() ?? '').get('intent')).toBe('delete');
    if (scripts) {
      // The enhanced form stays on the page and keeps what was typed.
      expect(answer.status()).toBe(400);
      await expect(form.getByLabel('Type your username to confirm')).toHaveValue(person.name);
    } else {
      expect(answer.status()).toBe(303);
      await page.waitForURL('/settings/account?error=password.wrong');
    }
    await expect(form.getByRole('alert')).toHaveText('The password is wrong.');

    // Still there: the page loads signed in, and a new sign-in works.
    await page.goto('/settings/account');
    await expect(page.getByText(`@${person.name}@`)).toBeVisible();
    const elsewhere = await (await browser.newContext({ extraHTTPHeaders })).newPage();
    await elsewhere.goto('/auth/sign-in');
    await elsewhere.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
    await signIn(elsewhere, person.email, person.password);
    await elsewhere.waitForURL('/');
    await elsewhere.context().close();
    await context.close();
  });
}
