import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Branch 5's notices and the thread follows end to end (lane f-notify), on the lane database: Follow
// thread from the post's bell and rail switch, with scripts and without; a followed thread's new
// comment in the inbox; a remote community's acceptance of a follow; the date groups; and Mark all read with its exact Undo, with a notice arriving in between. The cast is
// packages/core/src/testing/seed-notify.ts, written by the real actions and the real consumer. The
// steps share it and change it, so they run in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Cast = {
  password: string;
  suffix: string;
  reader: { name: string };
  other: { name: string };
  marker: { name: string };
  post: { id: string; title: string };
  markerPost: { id: string };
  remote: { name: string; handle: string };
};

const root = join(import.meta.dirname, '../..');
const seed = (...args: string[]) =>
  execFileSync('node', ['packages/core/src/testing/seed-notify.ts', ...args], { cwd: root, encoding: 'utf8' });

let cast: Cast;
test.beforeAll(() => {
  test.setTimeout(120_000);
  cast = JSON.parse(seed('e2e')) as Cast;
});

async function signedIn(page: Page, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, cast.password);
  await landed(page, '/');
}

/** A browser with scripts off, signed in: the forms are plain posts. */
async function plainPage(browser: Browser, name: string) {
  const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await page.goto('/auth/sign-in');
  await signIn(page, `@${name}`, cast.password);
  await page.waitForURL('/');
  return page;
}

const rows = (page: Page) => page.getByRole('list', { name: 'Notices' }).getByRole('listitem');
const inboxLink = (page: Page) => page.getByRole('banner').getByRole('link', { name: /^Inbox/ });
const bell = (page: Page) => page.getByRole('button', { name: 'Follow thread', exact: true });
const railSwitch = (page: Page) => page.getByRole('switch', { name: 'Follow thread' });
const unreadText = (page: Page, count: number) => page.getByRole('main').getByText(`${count} unread`, { exact: true });

test('the bell and the rail switch follow as one, and a new comment then lands once in Replies', async ({ page }) => {
  test.setTimeout(120_000);
  // Wide enough for the rail (and its switch) beside the centre column and the open sidebar.
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page, cast.reader.name);
  const log = recordConsole(page);
  await gotoHydrated(page, `/post/${cast.post.id}`);
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(railSwitch(page)).not.toBeChecked();
  await expectAccessible(page);

  await bell(page).click();
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(railSwitch(page)).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'Following this thread.' })).toHaveCount(1);
  await gotoHydrated(page, `/post/${cast.post.id}`);
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'true');

  // The reader has an accepted follow and a removal unread; the followed thread's comment makes three.
  await expect(inboxLink(page)).toHaveAccessibleName(/^Inbox\b.*\b2\b/);
  seed('comment', cast.post.id, cast.other.name);
  await gotoHydrated(page, '/notifications?filter=replies');
  await expect(rows(page)).toHaveCount(1);
  const row = rows(page).first();
  await expect(row).toContainText(`@${cast.other.name} commented in a thread you follow`);
  await expect(row.getByRole('link', { name: cast.post.title })).toHaveAttribute('href', new RegExp(`^/post/${cast.post.id}/comments/`));
  await expect(row.getByRole('button', { name: /^Reply: / })).toBeVisible();
  await expect(inboxLink(page)).toHaveAccessibleName(/^Inbox\b.*\b3\b/);
  await expect(unreadText(page, 3)).toBeVisible();
  // The reader's own comment in the thread tells nobody of it to themselves.
  seed('comment', cast.post.id, cast.reader.name);
  await page.reload();
  await expect(rows(page)).toHaveCount(1);

  // The switch unfollows; the bell follows suit, and a later comment tells nobody.
  await gotoHydrated(page, `/post/${cast.post.id}`);
  // From the keyboard (Mux draws the switch over its native input).
  await railSwitch(page).focus();
  await page.keyboard.press('Space');
  await expect(railSwitch(page)).not.toBeChecked();
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'false');
  seed('comment', cast.post.id, cast.other.name);
  await gotoHydrated(page, '/notifications?filter=replies');
  await expect(rows(page)).toHaveCount(1);
  expect(log.hydrationProblems()).toEqual([]);
});

test('without scripts the bell is a plain form both ways, back to the post', async ({ browser }) => {
  const page = await plainPage(browser, cast.reader.name);
  await page.goto(`/post/${cast.post.id}`);
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'false');
  await bell(page).click();
  await expect(page).toHaveURL(new RegExp(`/post/${cast.post.id}$`));
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'true');
  await bell(page).click();
  await expect(page).toHaveURL(new RegExp(`/post/${cast.post.id}$`));
  await expect(bell(page)).toHaveAttribute('aria-pressed', 'false');
  await page.context().close();
});

test('a remote community’s acceptance is an Account notice, and the notices sit under their date group', async ({ page }) => {
  await signedIn(page, cast.reader.name);
  await gotoHydrated(page, '/notifications?filter=account');
  await expect(rows(page)).toHaveCount(1);
  const accepted = rows(page).first();
  await expect(accepted).toContainText(`!${cast.remote.handle} accepted your request to join`);
  await expect(accepted.getByText('MOD', { exact: true })).toHaveCount(0);
  await expect(accepted.getByRole('link', { name: 'Open community' })).toHaveAttribute('href', `/c/${cast.remote.handle}`);

  // Every notice here arrived today.
  await gotoHydrated(page, '/notifications');
  await expect(page.getByRole('heading', { level: 2, name: 'Today' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Notices, Today' })).toBeVisible();
  await expectAccessible(page);
});

/** The header's unread count, from the Inbox link's accessible name ("Inbox 3 unread"); 0 without a count. */
const badge = async (page: Page) => Number((await inboxLink(page).ariaSnapshot()).match(/Inbox ([0-9]+) unread/)?.[1] ?? 0);

test('opening a followed thread’s notice or an accepted follow marks it read, and the header’s count follows without a page load', async ({
  page,
}) => {
  await signedIn(page, cast.reader.name);
  await gotoHydrated(page, '/notifications?filter=replies');
  const before = await badge(page);
  expect(before).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => Object.assign(window, { stayed: true }));
  // The read is held: the thread opens without waiting for it, and the count follows once it has committed.
  const reads: Route[] = [];
  await page.route(
    (url) => url.pathname === '/notifications' && url.searchParams.get('intent') === 'read',
    (route) => void reads.push(route),
  );
  await rows(page).first().getByRole('link', { name: cast.post.title }).click();
  await expect(page).toHaveURL(new RegExp(`/post/${cast.post.id}/comments/`));
  await expect(page.getByRole('main')).toContainText('A new comment');
  await expect.poll(() => reads.length).toBe(1);
  expect(await badge(page)).toBe(before);
  await reads[0]!.continue();
  await page.unrouteAll();
  await expect.poll(() => badge(page)).toBe(before - 1);

  await inboxLink(page).click();
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Account/ })
    .click();
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().getByRole('link', { name: 'Open community' }).click();
  await expect(page).toHaveURL(`/c/${cast.remote.handle}`);
  await expect.poll(() => badge(page)).toBe(before - 2);
  expect(await page.evaluate(() => 'stayed' in window)).toBe(true);
});

test('Undo of Mark all read restores exactly what was unread, with a notice arriving in between', async ({ page }) => {
  test.setTimeout(120_000);
  await signedIn(page, cast.marker.name);
  const log = recordConsole(page);
  await gotoHydrated(page, '/notifications');
  await expect(unreadText(page, 2)).toBeVisible();
  await expect(rows(page).getByRole('button', { name: /^Mark unread/ })).toHaveCount(1);

  await page.getByRole('button', { name: 'Mark all read' }).click();
  const undo = page.getByRole('button', { name: 'Undo: mark the 2 unread again' });
  await expect(undo).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Marked 2 notices as read.' })).toBeVisible();
  await expect(page).toHaveURL(/\/notifications\?marked=2&batch=[1-9][0-9]+$/);
  await expect(page.getByText('All read', { exact: true })).toBeVisible();

  // A reply arrives before the Undo: it is unread, and Undo leaves it so; the notice read before stays read.
  seed('comment', cast.markerPost.id, cast.other.name);
  await undo.click();
  await expect(page.getByRole('status').filter({ hasText: '2 notices are unread again.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark all read' })).toBeFocused();
  await expect(unreadText(page, 3)).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).getByRole('button', { name: /^Mark unread/ })).toHaveCount(1);
  await expect(inboxLink(page)).toHaveAccessibleName(/^Inbox\b.*\b3\b/);
  // Mux's pending Button announces itself in a live log that names it by reference; once Undo is gone the entry
  // names nothing until the log clears (a Mux gap, reported), so axe runs after it has.
  await expect(page.getByRole('log').getByRole('img')).toHaveCount(0, { timeout: 15_000 });
  await expectAccessible(page);
  expect(log.hydrationProblems()).toEqual([]);
});

/** Holds each Undo of Mark all read on its way: `arrived` waits for one, `next` hands it over to be answered. */
async function holdUndo(page: Page) {
  const waiting: Route[] = [];
  await page.route(
    (url) => url.pathname === '/notifications' && url.searchParams.get('intent') === 'undo_read_all',
    (route) => void waiting.push(route),
  );
  return { arrived: () => expect.poll(() => waiting.length).toBeGreaterThan(0), next: () => waiting.shift()! };
}

const markAllRead = (page: Page) => page.getByRole('button', { name: 'Mark all read' });
const undoButton = (page: Page) => page.getByRole('button', { name: /^Undo: mark the [0-9]+ unread again$/ });

test('a failed Undo keeps its button, focus and stamp, across a reload too, and then restores', async ({ page }) => {
  await signedIn(page, cast.marker.name);
  await gotoHydrated(page, '/notifications');
  await markAllRead(page).click();
  await expect(undoButton(page)).toBeFocused();
  const marked = page.url();
  const undo = await holdUndo(page);
  await undoButton(page).click();
  await undo.arrived();
  await undo.next().abort();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Something went wrong. Try again.');
  await expect(page).toHaveURL(marked);
  await expect(undoButton(page)).toBeFocused();

  await page.unrouteAll();
  await gotoHydrated(page, marked);
  await undoButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: /^[0-9]+ notices? (is|are) unread again\.$/ })).toHaveCount(1);
  await expect(markAllRead(page)).toBeFocused();
});

test('an Undo another tab made first says there was nothing left to undo, and focus goes to Mark all read', async ({ page }) => {
  await signedIn(page, cast.marker.name);
  await gotoHydrated(page, '/notifications');
  await markAllRead(page).click();
  await expect(undoButton(page)).toBeFocused();
  const other = await page.context().newPage();
  await gotoHydrated(other, page.url());
  await undoButton(other).click();
  await expect(other.getByRole('status').filter({ hasText: /unread again/ })).toHaveCount(1);
  await other.close();

  await undoButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Nothing left to undo.' })).toHaveCount(1);
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(markAllRead(page)).toBeFocused();
  // Said once: it goes with the next view.
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Unread/ })
    .click();
  await expect(page).toHaveURL(/\/notifications\?filter=unread$/);
  await expect(page.getByText('Nothing left to undo.')).toHaveCount(0);
});

test('an Undo answered after the reader changed filter leaves them there, with focus where they put it', async ({ page }) => {
  await signedIn(page, cast.marker.name);
  await gotoHydrated(page, '/notifications');
  await markAllRead(page).click();
  await expect(undoButton(page)).toBeFocused();
  const undo = await holdUndo(page);
  await undoButton(page).click();
  await undo.arrived();
  const unread = page.getByRole('main').getByRole('link', { name: /^Unread/ });
  await unread.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/notifications\?filter=unread$/);
  await unread.focus();
  await undo.next().continue();
  await expect(rows(page).first()).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/notifications\?filter=unread$/);
  await expect(unread).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: /unread again/ })).toHaveCount(0);
});

test('without scripts Mark all read and its Undo are plain forms', async ({ browser }) => {
  const page = await plainPage(browser, cast.marker.name);
  await page.goto('/notifications?filter=replies');
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page).toHaveURL(/\/notifications\?filter=replies&marked=3&batch=[1-9][0-9]+$/);
  await expect(page.getByRole('status').filter({ hasText: 'Marked 3 notices as read.' })).toBeVisible();
  // A second tab on the same answer, whose Undo comes after this one.
  const second = await page.context().newPage();
  await second.goto(page.url());
  await page.getByRole('button', { name: 'Undo: mark the 3 unread again' }).click();
  await expect(page).toHaveURL(/\/notifications\?filter=replies&restored=3$/);
  await expect(page.getByRole('status').filter({ hasText: '3 notices are unread again.' })).toBeVisible();
  await expect(unreadText(page, 3)).toBeVisible();
  await second.getByRole('button', { name: 'Undo: mark the 3 unread again' }).click();
  await expect(second).toHaveURL(/\/notifications\?filter=replies&restored=0$/);
  await expect(second.getByRole('status').filter({ hasText: 'Nothing left to undo.' })).toBeVisible();
  await page.context().close();
});
