import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane E1 end to end, on the built server and the lane database: the blocks page (three tabs as
// links, one add field each, Undo, every refusal, with and without JavaScript, in German), and
// what a block does to a feed and a thread. Each step has a viewer of its own, so they do not
// share state; the people they block are shared and are only ever blocked by one viewer each.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  suffix: string;
  password: string;
  viewers: string[];
  noisy: { name: string };
  friend: { name: string };
  remoteHost: string;
  remote: { handle: string };
  remoteCommunity: { handle: string };
  posts: { noisy: string; friend: string; friendTitle: string; remote: string };
  comments: { noisy: string; reply: string; friend: string };
};

let seed: Seed;
test.beforeAll(() => {
  const out = execFileSync('node', ['packages/core/src/testing/seed-e1.ts', 'e2e'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
  seed = JSON.parse(out) as Seed;
});

async function signedIn(page: Page, name: string) {
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await landed(page, '/');
}

/** A page of another context that is signed in as the same person, with or without scripts and in another language. */
async function sameSession(browser: Browser, page: Page, options: { javaScriptEnabled?: boolean; locale?: string } = {}) {
  const context = await browser.newContext({ storageState: await page.context().storageState(), ...options });
  return context.newPage();
}

const tab = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Kinds of block' }).getByRole('link', { name: new RegExp(`^${name}`) });
/**
 * Walks All by New page by page and reports which of `titles` it saw. The lane database is shared
 * with the other specs, so a seeded post is not always on the first page: the walk goes on until
 * every title in `present` has been seen, then one page more (a post older than those would be on
 * it), at most 12 pages.
 */
async function walkAll(page: Page, { present, absent = [] }: { present: string[]; absent?: string[] }) {
  const watched = [...present, ...absent];
  const seen = new Set<string>();
  let href: string | null = '/all?sort=new';
  let more = 1;
  for (let pages = 0; href && pages < 12; pages += 1) {
    await page.goto(href);
    const html = await page.content();
    for (const title of watched) if (html.includes(title)) seen.add(title);
    href = await page
      .locator('a[rel="next"]')
      .first()
      .getAttribute('href', { timeout: 1_000 })
      .catch(() => null);
    if (present.every((title) => seen.has(title)) && (more -= 1) < 0) break;
  }
  return seen;
}

const hostOfInstance = () => new URL(process.env.PUBLIC_ORIGIN ?? 'https://e1.peblish.test').host;

test('signed out, the page sends you to sign in', async ({ page }) => {
  await page.goto('/settings/blocks');
  await expect(page).toHaveURL(/\/auth\/sign-in\?redirect=%2Fsettings%2Fblocks/);
});

test('the page hydrates, lists the three tabs with counts, and has no axe violations, in English and German', async ({ page, browser }) => {
  const log = recordConsole(page);
  await signedIn(page, seed.viewers[0]!);
  await gotoHydrated(page, '/settings/blocks');
  await expect(page.getByRole('heading', { level: 1, name: 'Blocks' })).toBeVisible();
  await expect(tab(page, 'People')).toHaveAttribute('aria-current', 'page');
  await expect(tab(page, 'Communities')).toContainText('0');
  await expect(page.getByText('You have not blocked anyone.')).toBeVisible();
  await expectAccessible(page);
  expect(log.hydrationProblems()).toEqual([]);

  const german = await sameSession(browser, page, { locale: 'de-DE' });
  await gotoHydrated(german, '/settings/blocks?tab=instances');
  await expect(german.getByRole('heading', { level: 1, name: 'Blockierungen' })).toBeVisible();
  await expect(german.getByText('Du hast keine Instanzen blockiert.')).toBeVisible();
  await expectAccessible(german);
  await german.context().close();
});

test('a person is blocked by handle, listed with the date, and unblocked from the list or Undo', async ({ page }) => {
  await signedIn(page, seed.viewers[1]!);
  await gotoHydrated(page, '/settings/blocks');
  await page.getByLabel('Block a person by handle').fill(`@${seed.noisy.name}`);
  await page.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(page).toHaveURL(/tab=people&just=/);
  await expect(page.getByRole('status')).toContainText(`Blocked @${seed.noisy.name}.`);
  await expect(tab(page, 'People')).toContainText('1');
  const row = page.getByRole('list', { name: 'Blocked People' }).getByRole('listitem');
  await expect(row).toContainText(seed.noisy.name);
  await expect(row).toContainText('Blocked ');

  // Undo takes it back.
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('You have not blocked anyone.')).toBeVisible();
  await expect(tab(page, 'People')).toContainText('0');

  // Blocking twice is one row; Unblock on the row removes it.
  for (let n = 0; n < 2; n++) {
    await page.getByLabel('Block a person by handle').fill(`@${seed.noisy.name}`);
    await page.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(page.getByRole('status')).toBeVisible();
  }
  await expect(page.getByRole('list', { name: 'Blocked People' }).getByRole('listitem')).toHaveCount(1);
  // The page reloads its data after each add; a click that lands in the swap is repeated.
  const unblock = page.getByRole('button', { name: `Unblock @${seed.noisy.name}` });
  await expect(async () => {
    if (await unblock.count()) await unblock.click();
    await expect(page.getByText('You have not blocked anyone.')).toBeVisible({ timeout: 1_500 });
  }).toPass();
});

test('without JavaScript the same forms block and unblock', async ({ page, browser }) => {
  await signedIn(page, seed.viewers[2]!);
  const plain = await sameSession(browser, page, { javaScriptEnabled: false });
  await plain.goto('/settings/blocks?tab=communities');
  await expect(plain.getByRole('heading', { level: 1, name: 'Blocks' })).toBeVisible();
  await plain.getByLabel('Block a community by handle').fill(`!${seed.remoteCommunity.handle}`);
  await plain.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(plain.getByRole('status')).toContainText(`Blocked !${seed.remoteCommunity.handle}.`);
  await expect(plain.getByRole('list', { name: 'Blocked Communities' }).getByRole('listitem')).toHaveCount(1);
  await plain.getByRole('button', { name: `Unblock !${seed.remoteCommunity.handle}` }).click();
  await expect(plain.getByText('You have not blocked any communities.')).toBeVisible();

  // A refusal comes back in the address and is shown, with the text kept.
  await plain.getByLabel('Block a community by handle').fill('!nothing@nowhere.test');
  await plain.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(plain.getByRole('alert')).toContainText('Could not find !nothing@nowhere.test.');
  await expect(plain.getByLabel('Block a community by handle')).toHaveValue('!nothing@nowhere.test');
  await plain.context().close();
});

test('every refusal has its message', async ({ page }) => {
  await signedIn(page, seed.viewers[3]!);
  const attempt = async (tabName: string, field: string, text: string) => {
    await gotoHydrated(page, `/settings/blocks?tab=${tabName}`);
    await page.getByLabel(field).fill(text);
    await page.getByRole('button', { name: 'Block', exact: true }).click();
    return page.getByRole('alert');
  };
  await expect(await attempt('people', 'Block a person by handle', '@nobody_here@lemmy.test')).toContainText(
    'Could not find @nobody_here@lemmy.test.',
  );
  await expect(await attempt('people', 'Block a person by handle', 'two words')).toContainText("That is not a person's handle");
  await expect(await attempt('people', 'Block a person by handle', `@${seed.viewers[3]}`)).toContainText('You cannot block yourself');
  await expect(await attempt('communities', 'Block a community by handle', 'not a handle')).toContainText(
    "That is not a community's handle",
  );
  await expect(await attempt('instances', 'Block an instance by host', hostOfInstance())).toContainText('That is this instance.');
  await expect(await attempt('instances', 'Block an instance by host', 'not a host')).toContainText('That is not a host.');
  await expect(await attempt('instances', 'Block an instance by host', 'unknown-host.test')).toContainText(
    'Could not find unknown-host.test.',
  );
  await expectAccessible(page);
});

test('a blocked person leaves /all and is collapsed in a thread, for the blocker only', async ({ page, browser }) => {
  await signedIn(page, seed.viewers[4]!);
  expect(await walkAll(page, { present: [seed.posts.noisy, seed.posts.friendTitle] })).toEqual(
    new Set([seed.posts.noisy, seed.posts.friendTitle]),
  );
  await gotoHydrated(page, '/settings/blocks');
  await page.getByLabel('Block a person by handle').fill(`@${seed.noisy.name}`);
  await page.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(page.getByRole('status')).toBeVisible();

  expect(await walkAll(page, { present: [seed.posts.friendTitle], absent: [seed.posts.noisy] })).toEqual(new Set([seed.posts.friendTitle]));

  await gotoHydrated(page, `/post/${seed.posts.friend}`);
  const thread = page.getByRole('list', { name: 'Comments' }).first();
  await expect(thread).toContainText(seed.comments.friend);
  await expect(thread).toContainText(seed.comments.reply);
  await expect(thread).toContainText('Hidden: you blocked this person.');
  await expect(thread).not.toContainText(seed.comments.noisy);
  await expect(thread.getByText(seed.noisy.name).first()).toBeVisible();

  // Someone else still sees all of it.
  const other = await browser.newPage();
  await other.goto(`/post/${seed.posts.friend}`);
  await expect(other.getByRole('list', { name: 'Comments' }).first()).toContainText(seed.comments.noisy);
  expect(await walkAll(other, { present: [seed.posts.noisy, seed.posts.friendTitle] })).toEqual(
    new Set([seed.posts.noisy, seed.posts.friendTitle]),
  );
  await other.close();
});

test('an instance block hides what lives there', async ({ page }) => {
  await signedIn(page, seed.viewers[5]!);
  expect(await walkAll(page, { present: [seed.posts.remote] })).toEqual(new Set([seed.posts.remote]));
  await gotoHydrated(page, '/settings/blocks?tab=instances');
  await page.getByLabel('Block an instance by host').fill(`https://${seed.remoteHost}/`);
  await page.getByRole('button', { name: 'Block', exact: true }).click();
  const row = page.getByRole('list', { name: 'Blocked Instances' }).getByRole('listitem');
  await expect(row).toContainText(seed.remoteHost);
  await expect(row).toContainText('hides 2 people, 1 community');
  // The remote post is newer than the friend's, so the page with the friend's post would show it.
  expect(await walkAll(page, { present: [seed.posts.friendTitle], absent: [seed.posts.remote] })).toEqual(
    new Set([seed.posts.friendTitle]),
  );
});
