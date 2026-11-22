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

type Cast = {
  password: string;
  reader: { name: string };
  fan: { name: string };
  post: { id: string };
  markerPost: { id: string };
  gatedPost: { id: string; title: string };
};

let cast: Cast;
test.beforeAll(() => {
  test.setTimeout(120_000);
  const root = join(import.meta.dirname, '../..');
  cast = JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-notify.ts', 'e2e'], { cwd: root, encoding: 'utf8' })) as Cast;
});

/** Goes to another post inside the document, as a link does once hydrated. */
const openPost = (page: Page, id: string) =>
  page.evaluate(
    (target) =>
      (
        window as unknown as { __TSR_ROUTER__: { navigate(to: { to: string; params: { id: string } }): Promise<void> } }
      ).__TSR_ROUTER__.navigate({
        to: '/post/$id',
        params: { id: target },
      }),
    id,
  );
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

  // What was said belongs to that post: the router reuses the page for the next post in the same document,
  // and its status is empty there.
  await page.evaluate(() => Object.assign(window, { __survives: true }));
  await openPost(page, cast.markerPost.id);
  await expect(page).toHaveURL(new RegExp(`/post/${cast.markerPost.id}$`));
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(said(page, on)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __survives?: boolean }).__survives)).toBe(true);
});

test('a follower whose thread is gated since can unfollow there without scripts; nobody else is offered it', async ({ browser, page }) => {
  const gated = `/post/${cast.gatedPost.id}`;
  // Signed out, and signed in without following: the gate, and no bell.
  await gotoHydrated(page, gated);
  await expect(page.locator('main.gate')).toBeVisible();
  await expect(bell(page)).toHaveCount(0);
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${cast.reader.name}`, cast.password);
  await landed(page, '/');
  await gotoHydrated(page, gated);
  await expect(page.locator('main.gate')).toBeVisible();
  await expect(bell(page)).toHaveCount(0);

  // The follower, with scripts off: the gate still withholds the post, and the bell undoes the follow.
  const plain = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await plain.goto('/auth/sign-in');
  await signIn(plain, `@${cast.fan.name}`, cast.password);
  await plain.waitForURL('/');
  await plain.goto(gated);
  await expect(plain.locator('main.gate')).toBeVisible();
  await expect(plain.getByText(cast.gatedPost.title)).toHaveCount(0);
  await expect(bell(plain)).toHaveAttribute('aria-pressed', 'true');
  await bell(plain).click();
  await plain.waitForURL(gated);
  await expect(plain.locator('main.gate')).toBeVisible();
  await expect(bell(plain)).toHaveCount(0);
  await plain.context().close();
});
