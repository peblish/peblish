import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';

// Lane REP end to end, on the built server and the lane database: the report form with and
// without JavaScript, its dialog on the post page, and the sent page. The queue has its own
// describe below. The steps share seeded posts and reports, so they run in order.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

type Seed = {
  password: string;
  suffix: string;
  reporter: { name: string };
  second: { name: string };
  author: { name: string };
  moderator: { name: string };
  outsider: { name: string };
  community: { handle: string };
  other: { handle: string };
  posts: {
    form: string[];
    hate: string;
    sensitive: string;
    other: string;
    adminOnly: string;
    remove: string;
    escalate: string;
    dismiss: string;
  };
  titles: Record<'hate' | 'sensitive' | 'other' | 'adminOnly' | 'remove' | 'escalate' | 'dismiss', string>;
};

const root = join(import.meta.dirname, '../..');
let seed: Seed;
test.beforeAll(() => {
  seed = JSON.parse(execFileSync('node', ['packages/core/src/testing/seed-rep.ts', 'e2e'], { cwd: root, encoding: 'utf8' })) as Seed;
});

/** Signs in on a page that may have no JavaScript: a plain form post, then the home page. */
async function signedIn(page: Page, name: string) {
  await page.goto('/auth/sign-in');
  await signIn(page, `@${name}`, seed.password);
  await page.waitForURL('/');
}

const plain = async (browser: Browser) => (await browser.newContext({ javaScriptEnabled: false })).newPage();
const formUrl = (id: string, back = '/') => `/report?kind=post&id=${id}&back=${encodeURIComponent(back)}`;

test.describe('the report form', () => {
  test('without JavaScript: other needs details, then the report is sent and the receipt names the author', async ({ browser }) => {
    const page = await plain(browser);
    await signedIn(page, seed.reporter.name);
    const post = seed.posts.form[0]!;
    await page.goto(formUrl(post, `/post/${post}`));
    await expect(page.getByRole('heading', { name: 'Report this post' })).toBeVisible();
    // The routing line follows the choice in CSS: nothing chosen, then a category moderators see.
    await expect(page.getByText('Choose a category to see who will read your report.')).toBeVisible();
    await page.getByRole('radio', { name: /^Something else/ }).check();
    await expect(page.getByText(/The moderators of this community and the instance admins will see your report/)).toBeVisible();
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page).toHaveURL(/error=details\.required/);
    await expect(page.getByRole('alert')).toHaveText('Add details when you choose Something else.');
    await expect(page.getByRole('radio', { name: /^Something else/ })).toBeChecked();
    await page.getByRole('radio', { name: /^Spam/ }).check();
    await page.getByRole('textbox', { name: 'Details' }).fill('Selling watches in every thread');
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page).toHaveURL(/\/report\/sent\?n=\d+/);
    await expect(page.getByRole('heading', { name: /^Report #\d+ sent$/ })).toBeVisible();
    await expect(page.getByText(/you will get a message in your inbox/)).toBeVisible();
    await expect(page.getByRole('link', { name: `Block @${seed.author.name}` })).toHaveAttribute(
      'href',
      `/settings/blocks?person=${seed.author.name}`,
    );
    await page.getByRole('link', { name: 'Done' }).click();
    await expect(page).toHaveURL(`/post/${post}`);
    // A second report on the same post by the same person is refused on the page itself.
    await page.goto(formUrl(post));
    await expect(page.getByRole('alert')).toContainText('You already have an open report about this');
    await expect(page.getByRole('button', { name: 'Send report' })).toHaveCount(0);
  });

  test('signed out, the form sends you to sign in and back; a gone target is not found', async ({ request, page }) => {
    const out = await request.get(formUrl(seed.posts.form[1]!), { maxRedirects: 0 });
    expect(out.status()).toBe(303);
    expect(out.headers().location).toContain('/auth/sign-in?redirect=');
    await signedIn(page, seed.reporter.name);
    // A navigation, not page.request: the session cookie is Secure, which the request context does not send over http.
    const gone = await page.goto('/report?kind=post&id=019e0000-0000-7000-8000-000000000000');
    expect(gone?.status()).toBe(404);
  });

  test('the sent page is the reporter’s alone', async ({ page, browser }) => {
    await signedIn(page, seed.reporter.name);
    await page.goto(formUrl(seed.posts.form[1]!));
    await page.getByRole('radio', { name: /^Spam/ }).check();
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page).toHaveURL(/\/report\/sent\?n=\d+/);
    const receipt = page.url();
    const other = await browser.newContext();
    const stranger = await other.newPage();
    await signedIn(stranger, seed.second.name);
    expect((await stranger.goto(receipt))?.status()).toBe(404);
    await other.close();
  });

  test('hydrated: the Report control on the post page opens the form in a dialog, which sends and follows to the receipt', async ({
    page,
  }) => {
    const console = recordConsole(page);
    await gotoHydrated(page, '/auth/sign-in');
    await signIn(page, `@${seed.reporter.name}`, seed.password);
    await landed(page, '/');
    await gotoHydrated(page, `/post/${seed.posts.form[2]}`);
    await page.getByRole('link', { name: 'Report', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Report this post' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Form three')).toBeVisible();
    await dialog.getByRole('radio', { name: /^Child safety/ }).check();
    await expect(dialog.getByText(/Only the instance admins will see this report/)).toBeVisible();
    await expect(dialog.getByText(/Do not download, forward or attach/)).toBeVisible();
    await expectAccessible(page);
    await dialog.getByRole('radio', { name: /^Threats or harassment/ }).check();
    await dialog.getByRole('textbox', { name: 'Details' }).fill('Threatened me in a message');
    await dialog.getByRole('button', { name: 'Send report' }).click();
    await page.waitForURL(/\/report\/sent\?n=\d+/);
    await expect(page.getByRole('heading', { name: /^Report #\d+ sent$/ })).toBeVisible();
    expect(console.hydrationProblems()).toEqual([]);
  });

  test('the form page is accessible', async ({ page }) => {
    await gotoHydrated(page, '/auth/sign-in');
    await signIn(page, `@${seed.reporter.name}`, seed.password);
    await landed(page, '/');
    await gotoHydrated(page, formUrl(seed.posts.form[3]!));
    await expectAccessible(page);
  });
});
