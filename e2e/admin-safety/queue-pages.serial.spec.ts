import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { freshTotp, landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { withoutScripts } from './support.ts';

// The report queue past its first page, without JavaScript: a row's links (Show, Reporters and
// details) and its forms' way back keep the page's cursor, so they never land on page one, where
// that report may not be; the tabs and the filter start again from page one.
//
// Serial (it changes no setting): it needs more than one page of the queue's open tab, which every
// other spec's reports also fill, and a report closed elsewhere mid-test would shift its pages.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

type Seed = { password: string; admin: { name: string; totpSecret: string } };
const root = join(import.meta.dirname, '../..');
const seedRep = () =>
  JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-rep.ts', 'e2e'], { cwd: root, encoding: 'utf8' })) as Seed;

const queue = '/admin/reports?sort=oldest';

async function adminIn(page: Page, seed: Seed) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${seed.admin.name}`, seed.password);
  await landed(page, /\/auth\/two-factor/);
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(seed.admin.totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await landed(page, '/');
}

test('a row on the second page keeps that page, with scripts off', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const seed = seedRep();
  await adminIn(page, seed);
  // Each seed adds a handful of open groups; add more until there is a second page of 50.
  for (let round = 0; round < 15; round++) {
    await page.goto(queue);
    if ((await page.getByRole('link', { name: 'More' }).count()) > 0) break;
    seedRep();
  }

  const plain = await withoutScripts(page, browser);
  await plain.goto(queue);
  await plain.getByRole('link', { name: 'More' }).click();
  await expect(plain).toHaveURL(/cursor=/);
  // The router prints the cursor as JSON (`"50"`), a form's way back as it is (`50`): both are page two.
  const cursorOf = (href: string) => new URL(href, 'http://local').searchParams.get('cursor')?.replaceAll('"', '');
  const cursor = cursorOf(plain.url());
  expect(cursor).toBe('50');

  // A row with a quote: its Show and Reporters and details links, and its forms' way back.
  const first = plain
    .locator('tbody tr')
    .filter({ has: plain.getByRole('link', { name: 'Show' }) })
    .first();
  const details = first.getByRole('link', { name: 'Reporters and details' });
  const href = (await details.getAttribute('href'))!;
  const showOf = async (row: typeof first) =>
    new URL((await row.getByRole('link', { name: 'Show' }).getAttribute('href'))!, 'http://local').searchParams.get('show');
  const group = await showOf(first);
  expect(cursorOf(href)).toBe(cursor);
  expect(cursorOf((await first.getByRole('link', { name: 'Show' }).getAttribute('href'))!)).toBe(cursor);
  const backs = await first.locator('input[name="back"]').all();
  expect(backs.length).toBeGreaterThan(0);
  for (const back of backs) expect(cursorOf(await back.inputValue())).toBe(cursor);

  // Following it (or opening it in another tab) shows that row's reporters on the same page.
  await details.click();
  await expect(plain).toHaveURL(/details=/);
  expect(cursorOf(plain.url())).toBe(cursor);
  // The one row shown open is the row followed (its Show link names the same group). Mux Link drops
  // aria-expanded, so the open row is found by its list.
  const same = plain.locator('tbody tr').filter({ has: plain.locator('.rq-reporters:not([hidden])') });
  await expect(same).toHaveCount(1);
  expect(await showOf(same)).toBe(group);
  const other = await browser.newContext({ storageState: await page.context().storageState(), javaScriptEnabled: false });
  const tab = await other.newPage();
  await tab.goto(href);
  await expect(tab.locator('tbody tr').filter({ has: tab.locator('.rq-reporters:not([hidden])') })).toHaveCount(1);
  await other.close();

  // The tabs and the filter go back to page one.
  for (const link of await plain.getByRole('navigation', { name: 'Report queue' }).getByRole('link').all()) {
    expect(await link.getAttribute('href')).not.toContain('cursor=');
  }
  await expect(plain.locator('form.rq-filter input[name="cursor"]')).toHaveCount(0);
  await plain.getByRole('button', { name: 'Apply' }).click();
  await expect(plain).not.toHaveURL(/cursor=/);

  // A decision on page two comes back to page two.
  await plain.goto(`${queue}&cursor=${cursor}`);
  const dismiss = plain
    .locator('tbody tr')
    .filter({ has: plain.getByRole('button', { name: 'Dismiss' }) })
    .first();
  await dismiss.getByRole('button', { name: 'Dismiss' }).click();
  await plain.waitForURL(/\/admin\/reports/);
  expect(cursorOf(plain.url())).toBe(cursor);
  await plain.context().close();
});
