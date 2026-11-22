import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// A report row takes one action at a time: while Resolve is pending, its Dismiss and the row's Escalate
// post nothing. The answer is held in the browser and then refused, so the seeded reports stay open, and
// a refused row takes the next press.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ timeout: 90_000 });

type Seed = { password: string; moderator: { name: string }; titles: Record<'hate' | 'remove' | 'escalate' | 'dismiss', string> };
const root = join(import.meta.dirname, '../..');

test('a report row posts one action until the answer is in, and a refused row can act again', async ({ page }) => {
  const seed = JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-rep.ts', 'e2e'], { cwd: root, encoding: 'utf8' })) as Seed;
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${seed.moderator.name}`, seed.password);
  await landed(page, '/');
  await gotoHydrated(page, '/admin/reports');

  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const posted: string[] = [];
  await page.route('**/admin/reports', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posted.push(new URLSearchParams(route.request().postData() ?? '').get('intent') ?? '');
    await held;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: 'generic' }) });
  });

  const row = page.locator('tbody tr', { hasText: seed.titles.dismiss });
  await row.getByRole('button', { name: 'Resolve' }).click();
  await row.getByRole('button', { name: 'Dismiss' }).click({ force: true });
  await row.getByRole('button', { name: 'Escalate' }).click({ force: true });
  await page.waitForTimeout(300);
  expect(posted).toEqual(['resolve']);

  release();
  await expect(row.getByRole('alert')).toBeVisible();
  await row.getByRole('button', { name: 'Dismiss' }).click();
  await expect.poll(() => posted).toEqual(['resolve', 'dismiss']);
});
