import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { freshTotp, landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';
import { enterDoesNothing, postFromPage, postsTo, tick, withoutScripts } from './support.ts';

// The Media tab's three decisions (Confirm block, Hold, Release as clean) are Mux Tabs, which
// unmount the panels not shown. What an admin set in one (keep the posts, a note) must survive a
// look at another, must never show for another image, and Enter in a field must decide nothing.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database and bucket for its seeds');
// Each test signs in and walks several pages; other lanes share this machine, so allow for load.
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const root = join(import.meta.dirname, '../..');
const seed = <T>(...args: string[]): T =>
  JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-safe.ts', ...args], { cwd: root, encoding: 'utf8' })) as T;

type Admin = { name: string; password: string; totpSecret: string };
type Item = { mediaId: string; postId: string; postTitle: string; sha256: string };
let admin: Admin;
test.beforeAll(() => {
  admin = seed<Admin>('admin');
});
test.afterAll(async () => {
  await closePools();
});

async function signInAdmin(page: Page) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${admin.name}`, admin.password);
  await landed(page, /\/auth\/two-factor/);
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(admin.totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await landed(page, '/');
}

/** The parts of the decision control on the detail card. */
function decision(page: Page) {
  const detail = page.getByTestId('media-detail');
  return {
    detail,
    tab: (name: 'Confirm block' | 'Hold' | 'Release as clean') => detail.getByRole('tab', { name, exact: true }),
    removePosts: detail.getByRole('checkbox', { name: 'Also remove posts using it, if any' }),
    note: detail.getByRole('textbox', { name: 'Note for the evidence log optional' }),
    reference: detail.getByRole('textbox', { name: 'Reference' }),
    until: detail.getByLabel('Hold until'),
    releaseNote: detail.getByRole('textbox', { name: 'Note, required' }),
    forms: detail.locator('form'),
  };
}

const open = (page: Page, item: Item) => gotoHydrated(page, `/admin/media?section=review&item=${item.mediaId}`);

async function choose(tab: Locator) {
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

test('a draft survives Confirm to Hold to Confirm, and the next image starts fresh', async ({ page }) => {
  const first = seed<Item>('quarantined');
  const second = seed<Item>('quarantined');
  await signInAdmin(page);
  await open(page, first);
  const d = decision(page);
  await expect(d.detail).toContainText(first.sha256);

  await expect(d.removePosts).toBeChecked();
  await tick(d.removePosts, false);
  await d.note.fill('Keep the posts, they are a news report');
  await choose(d.tab('Hold'));
  await d.reference.fill('AFP-2026-0042');
  await choose(d.tab('Release as clean'));
  await d.releaseNote.fill('Looks like a false positive');
  await choose(d.tab('Confirm block'));
  await expect(d.removePosts).not.toBeChecked();
  await expect(d.note).toHaveValue('Keep the posts, they are a news report');
  await choose(d.tab('Hold'));
  await expect(d.reference).toHaveValue('AFP-2026-0042');
  await choose(d.tab('Release as clean'));
  await expect(d.releaseNote).toHaveValue('Looks like a false positive');
  // Only the decision shown is in the page, so the one posted is the one shown.
  await expect(d.forms).toHaveCount(1);
  await expect(d.forms).toHaveAttribute('aria-label', 'Release as clean');

  // The other image: nothing of the first one's draft, Confirm shown first, removal on.
  await page
    .getByTestId('quarantine-row')
    .filter({ hasText: second.sha256.slice(0, 8) })
    .getByRole('link')
    .click();
  await expect(d.detail).toContainText(second.sha256);
  await expect(d.tab('Confirm block')).toHaveAttribute('aria-selected', 'true');
  await expect(d.removePosts).toBeChecked();
  await expect(d.note).toHaveValue('');
  await choose(d.tab('Hold'));
  await expect(d.reference).toHaveValue('');
  await choose(d.tab('Release as clean'));
  await expect(d.releaseNote).toHaveValue('');
});

test('Confirm after a look at Hold keeps the posts the admin chose to keep', async ({ page }) => {
  const item = seed<Item>('quarantined');
  await signInAdmin(page);
  await open(page, item);
  const d = decision(page);
  const sent = postsTo(page, '/admin/media');
  await tick(d.removePosts, false);
  await d.note.fill('Posts stay');
  await choose(d.tab('Hold'));
  await choose(d.tab('Confirm block'));
  await d.detail.getByRole('button', { name: 'Confirm block' }).click();
  await expect(page.getByTestId('media-notice')).toContainText('Confirmed');
  await expect(page.getByTestId('media-notice')).not.toContainText('removed');
  expect(sent).toHaveLength(1);
  expect(Object.fromEntries(sent[0]!)).toEqual({ item: item.mediaId, note: 'Posts stay', intent: 'confirm' });
  expect(seed('object', item.mediaId)).toMatchObject({ state: 'blocked', exists: false });
});

test('Hold and Release each post their own decision', async ({ page }) => {
  const item = seed<Item>('quarantined');
  await signInAdmin(page);
  await open(page, item);
  const d = decision(page);
  const sent = postsTo(page, '/admin/media');

  await choose(d.tab('Hold'));
  await d.detail.getByLabel('Directed by').selectOption('ncmec');
  await d.reference.fill('NCMEC-77');
  await d.detail.getByRole('button', { name: 'Record hold' }).click();
  await expect(page.getByTestId('media-notice')).toContainText('Hold recorded.');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.get('intent')).toBe('hold');
  expect(sent[0]!.get('item')).toBe(item.mediaId);
  expect(sent[0]!.get('authority')).toBe('ncmec');
  expect(sent[0]!.has('removePosts')).toBe(false);

  await expect(d.detail).toContainText(item.sha256);
  await choose(d.tab('Release as clean'));
  await d.releaseNote.fill('A photo of a sunset');
  await d.detail.getByRole('button', { name: 'Release as clean' }).click();
  await expect(page.getByTestId('media-notice')).toContainText('Released.');
  expect(sent).toHaveLength(2);
  expect(Object.fromEntries(sent[1]!)).toEqual({ item: item.mediaId, note: 'A photo of a sunset', intent: 'release' });
  expect(seed<{ state: string }>('object', item.mediaId).state).toBe('clean');
});

test('Enter in a decision field decides nothing, with scripts on and off', async ({ page, browser }) => {
  const item = seed<Item>('quarantined');
  await signInAdmin(page);
  await open(page, item);
  const d = decision(page);
  const sent = postsTo(page, '/admin/media');
  await d.note.fill('typing a note');
  await enterDoesNothing(page, d.note, sent);
  await choose(d.tab('Hold'));
  await d.reference.fill('AFP-1');
  await enterDoesNothing(page, d.reference, sent);
  await enterDoesNothing(page, d.until, sent);
  await choose(d.tab('Release as clean'));
  await d.releaseNote.fill('not yet');
  await enterDoesNothing(page, d.releaseNote, sent);

  // Without scripts the page shows Confirm, which still works by its button, with removal off.
  const plain = await withoutScripts(page, browser);
  const plainSent = postsTo(plain, '/admin/media');
  await plain.goto(`/admin/media?section=review&item=${item.mediaId}`);
  const p = decision(plain);
  await expect(p.detail).toContainText(item.sha256);
  await p.note.fill('typing without scripts');
  await enterDoesNothing(plain, p.note, plainSent);
  await tick(p.removePosts, false);
  await p.detail.getByRole('button', { name: 'Confirm block' }).click();
  await expect(plain.getByTestId('media-notice')).toContainText('Confirmed');
  await expect(plain.getByTestId('media-notice')).not.toContainText('removed');
  expect(plainSent).toHaveLength(1);
  expect(plainSent[0]!.get('intent')).toBe('confirm');
  expect(plainSent[0]!.has('removePosts')).toBe(false);

  // Enter on the checkbox without scripts: the browser takes the hidden button with no decision, which the server refuses.
  const next = seed<Item>('quarantined');
  await plain.goto(`/admin/media?section=review&item=${next.mediaId}`);
  await p.removePosts.focus();
  await plain.keyboard.press('Enter');
  await expect(plain.getByTestId('media-error')).toContainText('Check the form and try again.');
  expect(plainSent).toHaveLength(2);
  expect(plainSent[1]!.has('intent')).toBe(false);
  expect(seed<{ state: string }>('object', next.mediaId).state).toBe('quarantined');
  await plain.context().close();
});

test('a post with no decision, or one the server does not know, is refused', async ({ page }) => {
  const item = seed<Item>('quarantined');
  await signInAdmin(page);
  await gotoHydrated(page, '/admin/media');
  const refused: Record<string, string>[] = [
    { item: item.mediaId },
    { item: item.mediaId, intent: 'purge-all' },
    { item: item.mediaId, intent: '' },
  ];
  for (const fields of refused) {
    const answer = await postFromPage(page, '/admin/media', fields);
    expect(answer.body).toContain('error=form.invalid');
  }
  expect(seed<{ state: string }>('object', item.mediaId).state).toBe('quarantined');
});

test('a manifest opens and closes in place', async ({ page }) => {
  // Confirmed above, so there is at least one manifest.
  await signInAdmin(page);
  await gotoHydrated(page, '/admin/media?section=evidence');
  const record = page.getByTestId('evidence-row').first();
  const toggle = record.getByRole('button', { name: 'View manifest' });
  const manifest = record.locator('pre');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(manifest).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(manifest).toBeVisible();
  await expect(manifest).toContainText('sha256');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(manifest).toBeHidden();
  await expect(page.locator('main img, main picture, main video, main canvas')).toHaveCount(0);
});
