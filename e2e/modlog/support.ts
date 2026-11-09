import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { freshTotp, landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// Lane MODF's end-to-end world (packages/core/src/testing/seed-modf.ts): a community with a
// moderator, an author, a spammer who posted and commented, a bystander and a peer's person.

export type World = {
  password: string;
  suffix: string;
  community: { id: string; handle: string };
  admin: { name: string; totpSecret: string };
  moderator: { name: string };
  author: { name: string };
  spammer: { name: string; actorId: string };
  bystander: { name: string };
  posts: { author: string; spam: string; remote: string };
  comments: { spam: string };
  peer: { domain: string; person: string };
};

export function seedWorld(): World {
  const out = execFileSync('node', ['packages/core/src/testing/seed-modf.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  return JSON.parse(out) as World;
}

export async function signedIn(page: Page, world: World, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, world.password);
  await landed(page, '/');
}

/** The world's own admin, past the two-factor step. */
export async function signedInAdmin(page: Page, world: World) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${world.admin.name}`, world.password);
  await landed(page, /\/auth\/two-factor/);
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(world.admin.totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await landed(page, '/');
}

/** A page in a context of its own (axe needs one; browser.newPage() would share the default). */
export async function freshPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}
