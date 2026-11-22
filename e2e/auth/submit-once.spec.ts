import { expect, test } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';

// A hydrated account form posts once per press and takes no second press until the answer is in: a
// recovery code pressed twice must not be spent twice. The answer is held in the browser, so no
// session or code is needed; a refusal unlocks the form for the next try.

test('the recovery form takes one press until the answer is in, and a refusal can be retried', async ({ page }) => {
  await gotoHydrated(page, '/auth/two-factor?recovery=yes');
  const form = page.getByRole('form', { name: 'Recovery code' });
  await form.getByLabel('Recovery code').fill('aaaa-bbbb');

  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let posts = 0;
  await page.route('**/auth/two-factor', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1;
    await held;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: 'two_factor.invalid_code' }) });
  });

  const verify = form.getByRole('button', { name: 'Verify' });
  await verify.click();
  await expect(form).toHaveAttribute('aria-busy', 'true');
  // A second press, and Enter in the field, while the first is pending.
  await verify.click({ force: true });
  await form.getByLabel('Recovery code').press('Enter');
  await page.waitForTimeout(300);
  expect(posts).toBe(1);

  release();
  await expect(form.getByRole('alert').first()).toHaveText('That code is wrong. Try the newest one.');
  await expect(form).toHaveAttribute('aria-busy', 'false');
  // Refused, the form takes the next press.
  await form.getByLabel('Recovery code').fill('cccc-dddd');
  await verify.click();
  await expect.poll(() => posts).toBe(2);
});

test('an address the browser will not go to frees the form for the next press; one it goes to keeps it held', async ({ page }) => {
  await gotoHydrated(page, '/auth/two-factor?recovery=yes');
  const form = page.getByRole('form', { name: 'Recovery code' });
  await form.getByLabel('Recovery code').fill('aaaa-bbbb');
  // The first answer leads to an address location.assign throws on; the second to the front page.
  const answers = [{ redirect: 'http://[' }, { redirect: '/' }];
  let posts = 0;
  await page.route('**/auth/two-factor', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const answer = answers[posts]!;
    posts += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) });
  });

  const verify = form.getByRole('button', { name: 'Verify' });
  await verify.click();
  await expect(form.getByRole('alert').first()).toBeVisible();
  await expect(form).toHaveAttribute('aria-busy', 'false');
  await verify.click();
  await page.waitForURL('/');
  expect(posts).toBe(2);
});
