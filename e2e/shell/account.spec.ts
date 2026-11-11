import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The account menu in the top bar (a Mux UI Menu): its entries navigate through the router and
// Sign out posts the shell's sign-out form.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

test('the account menu opens the account pages and signs out', async ({ page }) => {
  const { password, people } = JSON.parse(
    execFileSync('node', ['e2e/shell/seed.ts'], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }),
  ) as { password: string; people: [string, string] };
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${people[0]}`, password);
  await landed(page, '/');

  const banner = page.getByRole('banner');
  await expect(banner.getByRole('link', { name: 'Create post' })).toBeVisible();
  const trigger = banner.getByRole('button', { name: `Account: ${people[0]}` });
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'Account' });
  for (const name of ['Profile', 'Settings', 'Security', 'Sign out']) await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  // Not an admin: no Invites or Admin entries.
  await expect(menu.getByRole('menuitem', { name: 'Admin' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Settings' }).click();
  await page.waitForURL('**/settings/account');

  await trigger.click();
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(banner.getByRole('link', { name: 'Sign in' })).toBeVisible();
});
