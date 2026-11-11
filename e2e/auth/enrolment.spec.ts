import { expect, test, type Browser, type Page } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';
import { base32, landed, seed, signIn, totp, unique } from './support.ts';

// Review 2 AN1 through the real pages: two password sessions of one account. The second
// cannot confirm the first's TOTP setup, neither on the security page nor through the sign-in
// verifier (/auth/two-factor), and the owner confirming signs the second out.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

type Person = { email: string; password: string };

async function signedIn(browser: Browser, person: Person): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, person.email, person.password);
  await landed(page, '/');
  return page;
}

/** A form post from the page, answered as JSON (server/auth.ts respond). */
const post = (page: Page, path: string, form: Record<string, string>) =>
  page.evaluate(
    async ({ path, form }) => {
      const response = await fetch(path, { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams(form) });
      return { status: response.status, body: (await response.json()) as unknown };
    },
    { path, form },
  );

test('only the session that started a TOTP setup can confirm it, and confirming signs the other out', async ({ browser }) => {
  const person = seed('e2e-person', unique('enrol')) as Person;
  const laptop = await signedIn(browser, person);
  const phone = await signedIn(browser, person);

  await gotoHydrated(laptop, '/settings/security');
  await laptop.getByLabel('Confirm your password to start').fill(person.password);
  await laptop.getByRole('button', { name: 'Turn on' }).click();
  await landed(laptop, '/settings/security');
  const key = base32((await laptop.getByTestId('totp-key').textContent()) ?? '');

  await gotoHydrated(phone, '/settings/security');
  await expect(phone.getByTestId('totp-key')).toHaveCount(0);
  // The phone posts the laptop's current code to both pages that verify one, from its own page
  // (the session cookie is Secure, which only the browser sends here), as hydrated forms do. A
  // refused code does not use up its step, so the laptop confirms with the same code below.
  const code = totp(key);
  expect(await post(phone, '/settings/security', { intent: 'totp-verify', code })).toEqual({
    status: 200,
    body: { redirect: '/settings/security' },
  });
  expect(await post(phone, '/auth/two-factor', { method: 'totp', code })).toEqual({
    status: 400,
    body: { error: 'two_factor.invalid_code' },
  });
  await gotoHydrated(phone, '/settings/security');
  await expect(phone.getByText('Off.', { exact: true })).toBeVisible();

  await laptop.getByRole('textbox', { name: 'Code', exact: true }).fill(code);
  await laptop.getByRole('button', { name: 'Verify and turn on' }).click();
  await landed(laptop, '/settings/security');
  await expect(laptop.getByText('On.', { exact: true })).toBeVisible();
  await expect(laptop.getByTestId('recovery-codes').locator('li')).toHaveCount(10);

  await phone.goto('/settings/security');
  await landed(phone, /\/auth\/sign-in\?redirect=/);
});
