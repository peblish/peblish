import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane E2 end to end, on the built server and the lane database: the inbox of a person whose
// replies, mention, removals and ban were made by the real actions and written by the real
// consumer (testing/seed-e2.ts). The steps share one seeded inbox and change it, so they run in
// order: marking read with and without scripts, then everything read.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  suffix: string;
  me: { name: string };
  replier: { name: string };
  quiet: { name: string };
  busy: { name: string };
  remote: { handle: string };
  firstNoticeId: string;
};

let seed: Seed;
test.beforeAll(() => {
  // The seed waits for the outbox horizon (the oldest transaction running on the server), which a busy machine can hold back.
  test.setTimeout(120_000);
  const out = execFileSync('node', ['packages/core/src/testing/seed-e2.ts', 'e2e'], {
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

/** A browser with scripts off, signed in: the sign-in and inbox forms are plain posts. */
async function plainPage(browser: Browser, name: string) {
  const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await page.goto('/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await page.waitForURL('/');
  return page;
}

const rows = (page: Page) => page.locator('.pb-notice');
const inboxLink = (page: Page) => page.locator('.pb-side').getByRole('link', { name: /^Inbox/ });

test.describe('signed out', () => {
  test('answers 200 with a sign-in link and no data, privately', async ({ page, request }) => {
    const response = await request.get('/notifications');
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('private, no-store');
    const text = await response.text();
    expect(text).not.toContain(seed.me.name);
    expect(text).not.toContain('pb-notice');

    const log = recordConsole(page);
    await gotoHydrated(page, '/notifications');
    await expect(page.getByText('Sign in to see your inbox.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' }).last()).toHaveAttribute('href', '/auth/sign-in?redirect=%2Fnotifications');
    await expect(page).toHaveTitle(/^Inbox · /);
    await expectAccessible(page);
    expect(log.hydrationProblems()).toEqual([]);
  });

  test('a form post is refused across sites', async ({ request }) => {
    const response = await request.post('/notifications', { headers: { origin: 'https://evil.test' }, form: { intent: 'read_all' } });
    expect(response.status()).toBe(403);
  });
});

test.describe('a quiet inbox', () => {
  test('says nothing is new, has no badge and nothing to mark', async ({ page }) => {
    await signedIn(page, seed.quiet.name);
    const log = recordConsole(page);
    await gotoHydrated(page, '/notifications');
    await expect(page.getByText('Nothing new. Replies, mentions and moderator messages land here.')).toBeVisible();
    await expect(page.getByText('All read', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
    await expect(inboxLink(page)).toHaveAccessibleName('Inbox');
    await expect(page).toHaveTitle(/^Inbox · /);
    await expectAccessible(page);
    expect(log.hydrationProblems()).toEqual([]);
  });
});

test.describe('the inbox of a person who was replied to, mentioned, moderated and banned', () => {
  test('lists every kind once, with the badge, the title and no violations', async ({ page }) => {
    await signedIn(page, seed.me.name);
    const log = recordConsole(page);
    await gotoHydrated(page, '/notifications');
    await expect(rows(page)).toHaveCount(11);
    await expect(inboxLink(page)).toHaveAccessibleName(/^Inbox\b.*\b11\b/);
    await expect(page).toHaveTitle(/^\(11\) Inbox · /);
    await expect(page.getByText('11 unread', { exact: true })).toBeVisible();

    const text = (phrase: string) => rows(page).filter({ hasText: phrase });
    await expect(text('replied to your post')).toHaveCount(4);
    await expect(text('replied to your comment on')).toHaveCount(1);
    await expect(text('mentioned you in a comment on')).toHaveCount(1);
    await expect(text('removed your comment on')).toHaveCount(2);
    await expect(text('restored your comment on')).toHaveCount(1);
    await expect(text('banned you from')).toHaveCount(1);
    await expect(text('lifted your ban from')).toHaveCount(1);

    // A remote author's reply carries the peer's handle; the text is a plain excerpt.
    await expect(text('Hello from Lemmy')).toContainText(`@${seed.remote.handle}`);
    await expect(text('replied to your post').filter({ hasText: `Great post ${seed.suffix}` })).toHaveCount(1);

    // Sensitive content shows a word for everyone; a comment deleted after its notice shows that word.
    await expect(page.getByText('Sensitive content')).toBeVisible();
    await expect(page.getByText(`Hidden words ${seed.suffix}`)).toHaveCount(0);
    await expect(page.getByText(`Secret ${seed.suffix}`)).toHaveCount(0);
    await expect(text('Deleted')).toHaveCount(1);
    await expect(page.getByText(`Deleted later ${seed.suffix}`)).toHaveCount(0);
    // Removed text is never repeated; the reasons are, with a link to the public entry.
    await expect(page.getByText(`Rude words ${seed.suffix}`)).toHaveCount(0);
    await expect(page.getByText('Reason: Rule 3: no ads')).toBeVisible();
    await expect(page.getByText('Reason: Looked like spam')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Statement of reasons' })).toHaveCount(5);
    await expect(page.getByRole('link', { name: 'Statement of reasons' }).first()).toHaveAttribute('href', /^\/modlog\/[0-9a-f-]{36}$/);
    await expect(rows(page).getByText('MOD', { exact: true })).toHaveCount(5);

    await expectAccessible(page);
    expect(log.hydrationProblems()).toEqual([]);
  });

  test('each filter lists exactly its kinds', async ({ page }) => {
    await signedIn(page, seed.me.name);
    await gotoHydrated(page, '/notifications');
    const filters = page.getByRole('navigation', { name: 'Filter' });
    for (const [name, count, phrase] of [
      ['Replies', 5, 'replied to your'],
      ['Mentions', 1, 'mentioned you'],
      ['Your content', 3, 'your comment on'],
      ['Account', 2, 'ban'],
      ['Unread', 11, ''],
      ['All', 11, ''],
    ] as const) {
      await filters.getByRole('link', { name: new RegExp(`^${name}`) }).click();
      await expect(rows(page)).toHaveCount(count);
      await expect(rows(page).filter({ hasText: phrase })).toHaveCount(count);
    }
    await expect(filters.getByRole('link', { name: /^Replies/ })).toHaveAccessibleName('Replies 5 unread');
    await expect(filters.getByRole('link', { name: /^All/ })).toHaveAttribute('aria-current', 'page');
    // A filter the server does not know is All, not an error page.
    await page.goto('/notifications?filter=everything');
    await expect(rows(page)).toHaveCount(11);
  });

  test('without scripts a notice is marked read and unread by a plain form', async ({ browser }) => {
    const page = await plainPage(browser, seed.me.name);
    await page.goto('/notifications?filter=replies');
    await expect(rows(page)).toHaveCount(5);
    await rows(page).first().getByRole('button', { name: 'Mark read' }).click();
    await expect(page).toHaveURL(/\/notifications\?filter=replies$/);
    await expect(page.getByText('10 unread', { exact: true })).toBeVisible();
    await expect(rows(page).first().getByRole('button', { name: 'Mark unread' })).toBeVisible();
    await rows(page).first().getByRole('button', { name: 'Mark unread' }).click();
    await expect(page.getByText('11 unread', { exact: true })).toBeVisible();
    await page.context().close();
  });

  test('hydrated, marking read posts by fetch and the sidebar badge follows without a page load', async ({ page }) => {
    await signedIn(page, seed.me.name);
    const log = recordConsole(page);
    await gotoHydrated(page, '/notifications');
    await page.evaluate(() => Object.assign(window, { loadedOnce: true }));
    await rows(page).first().getByRole('button', { name: 'Mark read' }).click();
    await expect(page.getByText('10 unread', { exact: true })).toBeVisible();
    await expect(inboxLink(page)).toHaveAccessibleName(/^Inbox\b.*\b10\b/);
    await expect(rows(page).first().getByRole('button', { name: 'Mark unread' })).toBeVisible();
    expect(await page.evaluate(() => 'loadedOnce' in window)).toBe(true);
    // The Unread filter drops it.
    await page
      .getByRole('navigation', { name: 'Filter' })
      .getByRole('link', { name: /^Unread/ })
      .click();
    await expect(rows(page)).toHaveCount(10);
    expect(log.hydrationProblems()).toEqual([]);
  });

  test('Mark all read clears the badge and the Unread filter, and keeps the notices', async ({ page }) => {
    await signedIn(page, seed.me.name);
    await gotoHydrated(page, '/notifications');
    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect(page.getByText('All read', { exact: true })).toBeVisible();
    await expect(inboxLink(page)).toHaveAccessibleName('Inbox');
    await expect(page).toHaveTitle(/^Inbox · /);
    await expect(rows(page)).toHaveCount(11);
    await expect(rows(page).getByRole('button', { name: 'Mark unread' })).toHaveCount(11);
    await page
      .getByRole('navigation', { name: 'Filter' })
      .getByRole('link', { name: /^Unread/ })
      .click();
    await expect(page.getByText('Nothing new. Replies, mentions and moderator messages land here.')).toBeVisible();
    await expectAccessible(page);
  });

  test('another person cannot mark the notice, and the page names the refusal', async ({ page }) => {
    await signedIn(page, seed.replier.name);
    await gotoHydrated(page, '/notifications');
    const answer = await page.evaluate(async (id) => {
      const response = await fetch('/notifications', {
        method: 'POST',
        body: new URLSearchParams({ intent: 'read', id }),
        headers: { accept: 'application/json' },
      });
      return { status: response.status, body: (await response.json()) as { error?: string } };
    }, seed.firstNoticeId);
    expect(answer).toEqual({ status: 400, body: { error: 'notification.not_yours' } });
    await page.goto('/notifications?error=notification.not_yours');
    await expect(page.getByRole('alert')).toHaveText('That notice belongs to someone else.');
    await page.goto('/notifications?error=whatever');
    await expect(page.getByRole('alert')).toHaveText('Something went wrong. Try again.');
  });

  test('a long inbox pages with an Older link, none repeated', async ({ browser }) => {
    const page = await plainPage(browser, seed.busy.name);
    await page.goto('/notifications');
    await expect(rows(page)).toHaveCount(25);
    await page.getByRole('link', { name: 'Older' }).click();
    await expect(page).toHaveURL(/\/notifications\?cursor=[0-9a-f-]{36}$/);
    await expect(rows(page)).toHaveCount(5);
    await expect(page.getByRole('link', { name: 'Older' })).toHaveCount(0);
    await page.context().close();
  });
});

test.describe('in German', () => {
  test('the inbox speaks German, hydrates and has no violations', async ({ page, browser }) => {
    // The sign-in page is read in English; the signed-in session then opens the inbox in a German browser.
    await signedIn(page, seed.me.name);
    const context = await browser.newContext({ locale: 'de-DE', storageState: await page.context().storageState() });
    const german = await context.newPage();
    const log = recordConsole(german);
    await gotoHydrated(german, '/notifications');
    await expect(german.locator('html')).toHaveAttribute('lang', 'de-DE');
    await expect(german.getByRole('heading', { level: 1, name: 'Posteingang' })).toBeVisible();
    await expect(german.getByRole('button', { name: 'Alle als gelesen markieren' })).toBeVisible();
    await expect(rows(german).first().getByRole('button', { name: 'Als ungelesen markieren' })).toBeVisible();
    await german.waitForLoadState('networkidle');
    await expectAccessible(german);
    expect(log.hydrationProblems()).toEqual([]);
    await context.close();
  });
});
