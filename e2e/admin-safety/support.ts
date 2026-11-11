import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';

// Helpers for the admin safety specs: the safety controls of the Bans, Peers and Media tabs and
// the report queue, checked for what an admin can do by mistake.

/** Ticks or unticks a Mux checkbox by its label: Mux draws over a hidden native input, which Playwright will not click. */
export async function tick(control: Locator, checked: boolean) {
  await control.locator('xpath=ancestor::label[1]').click();
  await (checked ? expect(control).toBeChecked() : expect(control).not.toBeChecked());
}

/** The same signed-in session in a context of its own with scripts off. */
export async function withoutScripts(page: Page, browser: Browser): Promise<Page> {
  const storageState = await page.context().storageState();
  return (await browser.newContext({ storageState, javaScriptEnabled: false })).newPage();
}

/** Every POST the page sends to `path`, as the fields it posted, in order. */
export function postsTo(page: Page, path: string): URLSearchParams[] {
  const sent: URLSearchParams[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === path) sent.push(new URLSearchParams(request.postData() ?? ''));
  });
  return sent;
}

/** Presses Enter in a field and checks that nothing was posted and the page stayed where it was. */
export async function enterDoesNothing(page: Page, field: Locator, sent: URLSearchParams[]) {
  const before = sent.length;
  const url = page.url();
  await field.press('Enter');
  // A plain post would navigate and a hydrated one would fetch; give either time to start.
  await page.waitForTimeout(750);
  expect(sent.length).toBe(before);
  expect(page.url()).toBe(url);
}

/** Posts form fields from the page (the session cookie is Secure and lives in the page), answering JSON. */
export async function postFromPage(page: Page, path: string, fields: Record<string, string>) {
  return page.evaluate(
    async ({ path, fields }) => {
      const response = await fetch(path, { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams(fields) });
      return { status: response.status, body: (await response.text()).slice(0, 500) };
    },
    { path, fields },
  );
}

const root = join(import.meta.dirname, '../..');
const seed = (script: string, ...args: string[]): unknown =>
  JSON.parse(execFileSync('node', [`packages/core/src/testing/${script}`, ...args], { cwd: root, encoding: 'utf8' }));

/**
 * Rows for the Hashes, Review and Reports lists, so a spec that reads them does not depend on
 * others having run: a quarantined upload (its hash goes on the blocklist) and a report filed
 * by the named local admin.
 */
export function seedSafetyRows(adminName: string) {
  seed('seed-safe.ts', 'quarantined');
  seed('seed-rep.ts', 'payload', adminName);
}
