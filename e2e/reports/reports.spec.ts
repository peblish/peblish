import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, freshTotp, landed, signIn } from '../auth/support.ts';
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
  admin: { name: string; totpSecret: string };
  community: { handle: string };
  other: { handle: string };
  farHost: string;
  posts: {
    form: string[];
    hate: string;
    sensitive: string;
    other: string;
    adminOnly: string;
    remove: string;
    escalate: string;
    dismiss: string;
    forwarded: string;
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

  test('a forwarded report names the remote host and drops the anonymity promise; a back address off the site becomes /', async ({
    browser,
  }) => {
    const page = await plain(browser);
    await signedIn(page, seed.reporter.name);
    await page.goto(formUrl(seed.posts.forwarded));
    await page.getByRole('radio', { name: /^Spam/ }).check();
    await page
      .getByRole('checkbox', { name: `Also send to the moderators of ${seed.farHost}. They will see the report and your handle.` })
      .check();
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page).toHaveURL(/\/report\/sent\?n=\d+/);
    await expect(page.getByText(`The moderators of ${seed.farHost} can also see the report, including your handle.`)).toBeVisible();
    await expect(page.getByText(/will not learn who you are/)).toHaveCount(0);
    // A back address that leaves the site (a tab between the slashes) becomes / on the receipt and the form.
    const evil = '%2F%09%2Fevil.example';
    await page.goto(`/report/sent?n=${new URL(page.url()).searchParams.get('n')}&back=${evil}`);
    await expect(page.getByRole('link', { name: 'Done' })).toHaveAttribute('href', '/');
    await page.goto(`/report?kind=post&id=${seed.posts.form[3]}&back=${evil}`);
    await expect(page.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', '/');
  });

  test('the form page is accessible', async ({ page }) => {
    await gotoHydrated(page, '/auth/sign-in');
    await signIn(page, `@${seed.reporter.name}`, seed.password);
    await landed(page, '/');
    await gotoHydrated(page, formUrl(seed.posts.form[3]!));
    await expectAccessible(page);
  });
});

/** Who sees what in the queue, and what its actions leave behind. */
test.describe('the queue', () => {
  const queue = '/admin/reports';

  /** The group rows by the title of what was reported. */
  const row = (page: Page, title: string) => page.locator('tbody tr', { hasText: title });

  async function adminIn(page: Page) {
    await gotoHydrated(page, '/auth/sign-in');
    await signIn(page, `@${seed.admin.name}`, seed.password);
    await landed(page, /\/auth\/two-factor/);
    await page.getByRole('textbox', { name: 'Code', exact: true }).fill(await freshTotp(seed.admin.totpSecret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await landed(page, '/');
  }

  test('signed out is sent to sign in; someone who moderates nothing gets a 403', async ({ page, request }) => {
    const out = await request.get(queue, { maxRedirects: 0 });
    expect(out.status()).toBe(303);
    expect(out.headers().location).toContain('/auth/sign-in');
    await signedIn(page, seed.reporter.name);
    const response = await page.goto(queue);
    expect(response?.status()).toBe(403);
    await expect(page.getByRole('alert')).toHaveText('Only moderators and admins can open the report queue.');
  });

  test('a moderator sees their own community’s groups with the quote blurred, and nothing from elsewhere or for admins', async ({
    browser,
  }) => {
    const page = await plain(browser);
    await signedIn(page, seed.moderator.name);
    await page.goto(queue);
    for (const title of [seed.titles.hate, seed.titles.remove, seed.titles.escalate, seed.titles.dismiss]) {
      await expect(row(page, title)).toBeVisible();
    }
    // Sensitive content is withheld from the queue: its row names no title, only that it is hidden.
    await expect(page.locator('tbody tr', { hasText: 'Sensitive content is not shown here' })).toHaveCount(1);
    await expect(page.locator('tbody')).not.toContainText(seed.titles.sensitive);
    // Another community, an admins-only category and a person report are not theirs to read.
    await expect(page.locator('tbody')).not.toContainText(seed.titles.other);
    await expect(page.locator('tbody')).not.toContainText(seed.titles.adminOnly);
    await expect(page.locator('tbody')).not.toContainText(`@${seed.author.name}`.replace('@', '') + ' Person');
    // The page is only a moderator's Reports tab, and holds no image at all.
    expect(await page.locator('main').innerHTML()).not.toContain('<img');
    const hate = row(page, seed.titles.hate);
    await expect(hate.locator('blockquote')).toHaveAttribute('aria-hidden', 'true');
    await expect(hate.getByText('2 reports')).toBeVisible();
    // Without JavaScript Show is a link that reloads with the row shown; the shown quote is readable by assistive technology.
    await hate.getByRole('link', { name: 'Show' }).click();
    await expect(page).toHaveURL(/show=/);
    await expect(row(page, seed.titles.hate).locator('blockquote')).not.toHaveAttribute('aria-hidden', 'true');
    // Reporters and details are one disclosure away, staff only.
    await row(page, seed.titles.hate).getByText('Reporters and details').click();
    await expect(row(page, seed.titles.hate)).toContainText(`@${seed.reporter.name}`);
    await expect(row(page, seed.titles.hate)).toContainText('Slurs in the second paragraph');
  });

  test('another community’s moderator sees only theirs', async ({ browser }) => {
    const page = await plain(browser);
    await signedIn(page, seed.outsider.name);
    await page.goto(queue);
    await expect(row(page, seed.titles.other)).toBeVisible();
    await expect(page.locator('tbody')).not.toContainText(seed.titles.hate);
  });

  test('dismiss and escalate, without JavaScript', async ({ browser }) => {
    const page = await plain(browser);
    await signedIn(page, seed.moderator.name);
    await page.goto(queue);
    await row(page, seed.titles.dismiss).getByRole('button', { name: 'Dismiss' }).click();
    await expect(page).toHaveURL(/\/admin\/reports/);
    await expect(page.locator('tbody')).not.toContainText(seed.titles.dismiss);
    await page.goto(`${queue}?tab=dismissed`);
    await expect(row(page, seed.titles.dismiss)).toContainText('Dismissed by');
    await page.goto(queue);
    await row(page, seed.titles.escalate).getByRole('button', { name: 'Escalate' }).click();
    await expect(page.locator('tbody')).not.toContainText(seed.titles.escalate);
    await page.goto(`${queue}?tab=escalated`);
    await expect(row(page, seed.titles.escalate)).toContainText('Read only');
    await expect(row(page, seed.titles.escalate).getByRole('button')).toHaveCount(0);
  });

  test('an admin reads everything, sends the escalation back, and the admins-only report shows no content', async ({ page }) => {
    await adminIn(page);
    // The lane database keeps earlier runs, so the admin narrows to this run's communities.
    const mine = `community=${seed.community.handle}`;
    await gotoHydrated(page, `${queue}?tab=escalated&${mine}`);
    await expect(row(page, seed.titles.escalate)).toBeVisible();
    await row(page, seed.titles.escalate).getByRole('button', { name: 'Send back' }).click();
    await expect(row(page, seed.titles.escalate)).toHaveCount(0, { timeout: 15_000 });
    await gotoHydrated(page, `${queue}?${mine}`);
    await expect(row(page, seed.titles.escalate)).toBeVisible();
    await gotoHydrated(page, `${queue}?community=${seed.other.handle}`);
    await expect(row(page, seed.titles.other)).toBeVisible();
    await gotoHydrated(page, `${queue}?tab=admins&${mine}`);
    // The child-safety group shows no content: its type, a message and Open, never the title.
    await expect(page.locator('tbody')).not.toContainText(seed.titles.adminOnly);
    const withheld = page.locator('tbody tr', { hasText: 'Admins only. Open it to review.' });
    await expect(withheld).toHaveCount(1);
    await expect(withheld.getByRole('link', { name: 'Open' })).toBeVisible();
    await expect(page.locator('tbody tr', { hasText: 'Person' })).toHaveCount(0);
    await expectAccessible(page);
  });

  test('hydrated: Show reveals the quote in the browser, and Remove writes the statement, the modlog row and the event', async ({
    page,
  }) => {
    const console = recordConsole(page);
    await gotoHydrated(page, '/auth/sign-in');
    await signIn(page, `@${seed.moderator.name}`, seed.password);
    await landed(page, '/');
    await gotoHydrated(page, queue);
    const hate = row(page, seed.titles.hate);
    await expect(hate.locator('blockquote')).toHaveAttribute('aria-hidden', 'true');
    await hate.getByRole('link', { name: 'Show' }).click();
    await expect(hate.locator('blockquote')).not.toHaveAttribute('aria-hidden', 'true');
    await expect(page).not.toHaveURL(/show=/);
    await expectAccessible(page);
    const remove = row(page, seed.titles.remove);
    await remove.getByText('Remove', { exact: true }).click();
    await remove.getByLabel('Community rule').selectOption('6');
    await remove.getByLabel('Explanation').fill('The link collects card numbers.');
    await remove.getByRole('button', { name: 'Remove and resolve' }).click();
    await expect(row(page, seed.titles.remove)).toHaveCount(0, { timeout: 15_000 });
    await page.goto(`${queue}?tab=resolved`);
    // Removed content shows no quote, so the row is found by who removed it.
    await expect(page.locator('tbody tr', { hasText: `Removed by @${seed.moderator.name}` })).toBeVisible();
    const left = JSON.parse(
      execFileSync('node', ['packages/core/src/testing/seed-rep.ts', 'after', seed.posts.remove], { cwd: root, encoding: 'utf8' }),
    ) as { modlog: { action: string; reason: string; public: boolean }[]; resolved: number };
    expect(left.modlog).toHaveLength(1);
    expect(left.modlog[0]).toMatchObject({ action: 'mod.remove', public: true });
    expect(left.modlog[0]?.reason).toContain('community rule 6');
    expect(left.modlog[0]?.reason).not.toContain(seed.reporter.name);
    expect(left.resolved).toBeGreaterThan(0);
    expect(console.hydrationProblems()).toEqual([]);
  });
});
