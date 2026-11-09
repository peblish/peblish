import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectAccessible, freshTotp, landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// The admin Media tab and /media/<id> on the built server and the lane database (lane SAFE). The
// seeds (packages/core/src/testing/seed-safe.ts) put real rows in the lane database and the
// lane bucket. The scan providers are never called: the server runs with MEDIASCAN_LOCAL_ONLY=1
// (the other specs' uploads need it; the unit tests cover the fail-closed no-provider case).
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database and bucket for its seeds');
test.describe.configure({ mode: 'serial' });

const root = join(import.meta.dirname, '../..');
const seed = <T>(...args: string[]): T =>
  JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-safe.ts', ...args], { cwd: root, encoding: 'utf8' })) as T;

type Admin = { name: string; password: string; totpSecret: string };
let admin: Admin;
test.beforeAll(() => {
  admin = seed<Admin>('admin');
});
test.afterAll(() => {
  seed('remote-media', 'on');
});

async function signInAdmin(page: import('@playwright/test').Page) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${admin.name}`, admin.password);
  await landed(page, /\/auth\/two-factor/);
  await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(admin.totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await landed(page, '/');
}

test('signed out, the tab asks for a sign-in', async ({ page }) => {
  await page.goto('/admin/media');
  await expect(page).toHaveURL(/\/auth\/sign-in/);
});

test('the Media tab shows the scanner state, never an image, and Confirm purges a quarantined upload', async ({ page }) => {
  const item = seed<{ mediaId: string; state: string; postId: string; postTitle: string; sha256: string }>('quarantined');
  expect(item.state).toBe('quarantined');
  await signInAdmin(page);
  await gotoHydrated(page, '/admin/media');

  // The tab bar marks Media, and the warning says the scanner is the local list only (this server
  // is a development one; with no setting at all it would say "No scanner configured").
  await expect(page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Media' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByTestId('scanner-warning')).toContainText(/Local list only|No scanner configured/);
  await expect(page.getByTestId('media-status')).toContainText('Uploads');

  // The seeded quarantine is listed with its short hash; nothing on the page is an image or links to one.
  const row = page.getByTestId('quarantine-row').filter({ hasText: item.sha256.slice(0, 8) });
  await expect(row).toBeVisible();
  await row.getByRole('link').click();
  await expect(page.getByTestId('media-detail')).toContainText(item.sha256);
  await expect(page.getByTestId('media-detail')).toContainText(item.postTitle);
  await expect(page.locator('main img, main picture, main video, main canvas')).toHaveCount(0);
  await expect(page.locator(`main a[href*="/media/${item.mediaId}"]`)).toHaveCount(0);
  expect(seed<{ exists: boolean }>('object', item.mediaId).exists).toBe(true);
  await expectAccessible(page);

  // Confirm and purge, with "also remove posts using it" on.
  await page.getByRole('button', { name: 'Confirm block' }).click();
  await expect(page.getByTestId('media-notice')).toContainText('Confirmed');
  await expect(page.getByTestId('media-notice')).toContainText('1 post removed');
  await expect(page.getByTestId('quarantine-row').filter({ hasText: item.sha256.slice(0, 8) })).toHaveCount(0);
  expect(seed('object', item.mediaId)).toEqual({ state: 'blocked', storageKey: null, exists: false });

  // The hash is on the list and the manifest is in the evidence section.
  await gotoHydrated(page, '/admin/media?section=hashes');
  await expect(page.getByTestId('hash-row').filter({ hasText: item.sha256.slice(0, 8) })).toBeVisible();
  await gotoHydrated(page, '/admin/media?section=evidence');
  await expect(page.getByTestId('evidence-row').first()).toContainText('Purged');
});

test('a bad hash is refused with its reason and an added one is listed', async ({ page }) => {
  await signInAdmin(page);
  await gotoHydrated(page, '/admin/media?section=hashes');
  await expectAccessible(page);
  await page.getByLabel('SHA-256', { exact: true }).fill('9f2c41ab6d03e5b7c18a2f94d0e37b5a61c8f20d');
  await page.getByRole('button', { name: 'Add and quarantine matches' }).click();
  await expect(page.getByTestId('media-error')).toContainText('Expected 64 hexadecimal characters.');
  // Fresh per run: the lane database keeps earlier runs, and a hash can be listed once.
  const hash = randomBytes(32).toString('hex');
  await page.getByLabel('SHA-256', { exact: true }).fill(hash);
  await page.getByRole('button', { name: 'Add and quarantine matches' }).click();
  await expect(page.getByTestId('media-notice')).toContainText('0 existing images quarantined');
  await expect(page.getByTestId('hash-row').filter({ hasText: hash.slice(0, 8) })).toBeVisible();
});

test('the remote-media pause switch stops the proxy but not a clean upload; every other /media/<id> is the same 404', async ({
  request,
}) => {
  const rows = seed<Record<'pending' | 'clean' | 'quarantined' | 'blocked' | 'failed' | 'deleted' | 'unknown', string>>('states');
  const proxy = execFileSync('node', ['packages/core/src/testing/seed-b2.ts', 'proxy-path', 'https://img.example/a.png'], {
    cwd: root,
    encoding: 'utf8',
  });
  seed('remote-media', 'off');
  const proxied = await request.get(JSON.parse(proxy) as string);
  expect([proxied.status(), proxied.headers()['cache-control']]).toEqual([404, 'no-store']);

  const clean = await request.get(`/media/${rows.clean}`);
  expect(clean.status()).toBe(200);
  expect(clean.headers()).toMatchObject({
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'public, max-age=300',
  });
  expect(clean.headers().etag).toMatch(/^"[0-9a-f]{64}"$/);
  expect((await request.head(`/media/${rows.clean}`)).status()).toBe(200);

  const answers = [];
  for (const id of [rows.unknown, rows.pending, rows.quarantined, rows.blocked, rows.failed, rows.deleted, 'not-a-uuid']) {
    const response = await request.get(`/media/${id}`);
    answers.push({
      status: response.status(),
      cache: response.headers()['cache-control'],
      type: response.headers()['content-type'],
      body: await response.text(),
    });
  }
  expect(answers[0]).toMatchObject({ status: 404, cache: 'no-store' });
  for (const answer of answers) expect(answer).toEqual(answers[0]);
  seed('remote-media', 'on');
});
