import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { landed, signIn } from '../auth/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// Follow thread on the post page (follow-thread.tsx): the bell and the rail's switch share one state and one
// polite status, so a change made with either is said once, in one place. The journeys with the inbox are in
// e2e/notifications/follows.spec.ts; the cast is packages/core/src/testing/seed-notify.ts.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Cast = { password: string; reader: { name: string }; post: { id: string }; markerPost: { id: string } };

let cast: Cast;
test.beforeAll(() => {
  test.setTimeout(120_000);
  const root = join(import.meta.dirname, '../..');
  cast = JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-notify.ts', 'e2e'], { cwd: root, encoding: 'utf8' })) as Cast;
});

const bell = (page: Page) => page.getByRole('button', { name: 'Follow thread', exact: true });
const railSwitch = (page: Page) => page.getByRole('switch', { name: 'Follow thread' });
const said = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });
const on = 'Following this thread. New comments come to your inbox.';
const off = 'No longer following this thread.';

test('the rail switch’s change is said once, in the bell’s status, and the bell’s change too', async ({ page }) => {
  // Wide enough for the rail (and its switch) beside the centre column and the open sidebar.
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${cast.reader.name}`, cast.password);
  await landed(page, '/');
  await gotoHydrated(page, `/post/${cast.post.id}`);
  await expect(railSwitch(page)).not.toBeChecked();

  await railSwitch(page).focus();
  await page.keyboard.press('Space');
  await expect(railSwitch(page)).toBeChecked();
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(said(page, on)).toHaveCount(1);
  await expect(railSwitch(page)).toBeFocused();

  await page.keyboard.press('Space');
  await expect(railSwitch(page)).not.toBeChecked();
  await expect(said(page, off)).toHaveCount(1);
  await expect(said(page, on)).toHaveCount(0);

  await bell(page).click();
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(said(page, on)).toHaveCount(1);
  await expect(said(page, off)).toHaveCount(0);

  // What was said belongs to that post: on another post, and back, the status is empty.
  await gotoHydrated(page, `/post/${cast.markerPost.id}`);
  await expect(said(page, on)).toHaveCount(0);
  await gotoHydrated(page, `/post/${cast.post.id}`);
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(said(page, on)).toHaveCount(0);
});
