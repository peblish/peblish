import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { landed, signIn, freshTotp, type Admin } from '../auth/support.ts';

// Helpers for the lane ADM specs: the seeded admin signed in with a TOTP code, and the
// lane's own seed.

const root = join(import.meta.dirname, '../..');

/** packages/core/src/testing/seed-adm.ts against the lane database (DATABASE_URL from lane.sh). */
export function seedAdm(...args: string[]): unknown {
  return JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-adm.ts', ...args], { cwd: root, encoding: 'utf8' }));
}

/** Signs the e2e admin in, through the password and the two-factor step. */
export async function signInAdmin(page: Page, admin: Admin): Promise<void> {
  await page.goto('/auth/sign-in');
  await signIn(page, `@${admin.name}`, admin.password);
  await landed(page, /\/auth\/two-factor/);
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(admin.totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await landed(page, '/');
}
