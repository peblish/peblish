import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { signIn } from '../auth/support.ts';

// Lane REP's end-to-end world (packages/core/src/testing/seed-rep.ts) and the helpers its specs share.

export type Seed = {
  password: string;
  suffix: string;
  reporter: { name: string };
  second: { name: string };
  author: { name: string };
  moderator: { name: string };
  outsider: { name: string };
  admin: { name: string; totpSecret: string };
  community: { handle: string };
  other: { handle: string };
  farHost: string;
  posts: {
    form: string[];
    hate: string;
    sensitive: string;
    other: string;
    adminOnly: string;
    remove: string;
    escalate: string;
    dismiss: string;
    forwarded: string;
  };
  titles: Record<'hate' | 'sensitive' | 'other' | 'adminOnly' | 'remove' | 'escalate' | 'dismiss', string>;
};

export const root = join(import.meta.dirname, '../..');

/** A fresh world: every run uses new names, so the lane database can keep earlier runs. */
export const seedReports = () =>
  JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-rep.ts', 'e2e'], { cwd: root, encoding: 'utf8' })) as Seed;

/** Signs in on a page that may have no JavaScript: a plain form post, then the home page. */
export async function signedIn(page: Page, seed: Seed, name: string) {
  await page.goto('/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await page.waitForURL('/');
}

/**
 * Chooses a Mux radio or checkbox as a person does, by its label: Mux draws the control over a
 * visually hidden native input, which Playwright will not click. Returns once the input agrees.
 */
export async function tick(control: Locator, checked = true) {
  await control.locator('xpath=ancestor::label[1]').click();
  await (checked ? expect(control).toBeChecked() : expect(control).not.toBeChecked());
}

export const plain = async (browser: Browser) => (await browser.newContext({ javaScriptEnabled: false })).newPage();
export const formUrl = (id: string, back = '/') => `/report?kind=post&id=${id}&back=${encodeURIComponent(back)}`;
