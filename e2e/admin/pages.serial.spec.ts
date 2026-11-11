import { expect, test, type Browser, type Page } from '@playwright/test';
import type { Admin } from '../auth/support.ts';
import { expectAccessible } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import { seedAdm, signInAdmin } from './support.ts';

// The admin Pages tab and the public pages at /<slug>, on the built server and the lane database:
// adding the shipped drafts, the editor, the tokens that refuse a publish, what a signed-out visitor
// reads, and the German version. The steps share one signed-in admin and one page's history, so they
// run in order. It saves the operator details in site settings, so it is a serial spec (e2e/playwright.config.ts).
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let page: Page;
let account: { name: string; password: string };
test.beforeAll(async ({ browser }) => {
  const { admin, member } = seedAdm('e2e-pages') as { admin: Admin; member: { name: string; password: string } };
  account = member;
  page = await (await browser.newContext()).newPage();
  await signInAdmin(page, admin);
});
test.afterAll(async () => page.context().close());

/** A visitor who is not signed in, in a language. */
async function visitor(browser: Browser, locale = 'en-US') {
  const context = await browser.newContext({ locale });
  return { context, page: await context.newPage() };
}

const rules = '/admin/pages/rules/en';

/** A page's row in the pages table, found by its name in the row header. */
const pageRow = (on: Page, name: string) => on.getByRole('row').filter({ has: on.getByRole('rowheader', { name, exact: true }) });
/** One language's cell in a page's row: its status and Edit link. */
const languageCell = (on: Page, name: string, language: 'en' | 'de') => pageRow(on, name).locator(`[data-language="${language}"]`);

/** The editor's Preview tab, opened: the saved draft as visitors will see it. */
async function openPreview(on: Page) {
  await on.getByRole('tab', { name: 'Preview' }).click();
  return on.getByRole('tabpanel', { name: 'Preview' });
}

test('a fresh instance has no pages: the list says so and offers the shipped drafts, and nothing is public yet', async ({ browser }) => {
  const console = recordConsole(page);
  await gotoHydrated(page, '/admin/pages');
  await expect(page.getByRole('heading', { level: 1, name: 'Pages' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No pages yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add the shipped drafts' })).toBeVisible();
  await expectAccessible(page);
  expect(console.hydrationProblems()).toEqual([]);
  const { context, page: reader } = await visitor(browser);
  expect((await reader.goto('/rules'))?.status()).toBe(404);
  await context.close();
});

test('adding the shipped drafts fills the list: nine English drafts, About not added, and the button is gone', async () => {
  await page.getByRole('button', { name: 'Add the shipped drafts' }).click();
  await page.waitForURL(/added=/);
  await expect(page.getByRole('status')).toHaveText('Added 9 drafts.');
  await expect(page.getByRole('rowheader')).toHaveCount(10);
  await expect(languageCell(page, 'Community rules', 'en')).toContainText('Draft');
  await expect(languageCell(page, 'Community rules', 'de')).toContainText('Not added');
  await expect(languageCell(page, 'About', 'en')).toContainText('Not added');
  await expect(page.getByRole('link', { name: 'View' })).toHaveCount(0);
  // Every shipped draft is there, so there is nothing left to add.
  await expect(page.getByRole('button', { name: 'Add the shipped drafts' })).toHaveCount(0);
  await expectAccessible(page);
});

test('publishing is refused while the operator details are empty, and the editor lists the placeholders', async () => {
  await gotoHydrated(page, rules);
  await expect(page.getByLabel('Title')).toHaveValue('Community rules');
  const preview = await openPreview(page);
  await expect(preview.getByRole('heading', { name: 'The saved draft, as visitors will see it' })).toBeVisible();
  await expect(preview).toContainText('{{CONTACT_EMAIL}}');
  await page.getByRole('tab', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.waitForURL(/error=page.unresolved_tokens/);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Not published');
  await expect(alert.locator('code')).toHaveText(['{{CONTACT_EMAIL}}']);
  await expect(alert.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/admin/settings');
  await expectAccessible(page);
});

test('a page that holds a token the site does not fill cannot publish, and the alert names it beside the empty operator details', async () => {
  // The privacy policy's archive deletion date is written in by hand on cutover day; no setting fills it.
  await gotoHydrated(page, '/admin/pages/privacy/en');
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.waitForURL(/error=page.unresolved_tokens/);
  await expect(page.getByRole('alert').locator('code')).toHaveText([
    '{{OPERATOR_NAME}}',
    '{{JURISDICTION}}',
    '{{CONTACT_EMAIL}}',
    '{{POSTAL_ADDRESS}}',
    '{{PIEFED_ARCHIVE_DELETE_DATE}}',
  ]);
});

test('with the operator details filled in, rules publishes, and a signed-out visitor reads it with the details in place', async ({
  browser,
}) => {
  await gotoHydrated(page, '/admin/settings');
  await page.getByLabel('Name', { exact: true }).fill('Test Operator');
  await page.getByLabel('Contact email').fill('hello@operator.test');
  await page.getByLabel('Postal address').fill('Main Street 1\n10115 Berlin');
  await page.getByLabel('Jurisdiction').fill('Berlin');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(/saved=/);
  await gotoHydrated(page, rules);
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.waitForURL(/saved=published/);
  await expect(page.getByRole('status')).toHaveText('Published.');
  await expect(page.getByRole('button', { name: 'Unpublish' })).toBeVisible();
  await gotoHydrated(page, '/admin/pages');
  await expect(languageCell(page, 'Community rules', 'en')).toContainText('Published');
  await expect(languageCell(page, 'Community rules', 'en')).toContainText('adm_pages_admin');
  await expect(pageRow(page, 'Community rules').getByRole('link', { name: 'View' })).toHaveAttribute('href', '/rules');

  const { context, page: reader } = await visitor(browser);
  const console = recordConsole(reader);
  await gotoHydrated(reader, '/rules');
  await expect(reader.getByRole('heading', { level: 1, name: 'Community rules' })).toBeVisible();
  await expect(reader.locator('article')).toContainText('hello@operator.test');
  await expect(reader.locator('article')).not.toContainText('{{');
  await expect(reader.locator('article')).toHaveAttribute('lang', 'en');
  await expect(reader).toHaveTitle(/^Community rules · /);
  // The list names the live pages and nothing else.
  await expect(reader.getByRole('navigation', { name: 'Legal and safety' }).getByRole('link')).toHaveText(['Community rules']);
  await expectAccessible(reader);
  expect(console.hydrationProblems()).toEqual([]);
  // A page nobody published, and a slug the instance does not have, are 404s.
  expect((await reader.goto('/terms'))?.status()).toBe(404);
  expect((await reader.goto('/no-such-page'))?.status()).toBe(404);
  await context.close();
});

test('an edit stays a draft until it is published: the list says so and visitors keep the live text', async ({ browser }) => {
  await gotoHydrated(page, rules);
  await page.getByLabel('Title').fill('House rules');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.waitForURL(/saved=draft/);
  await expect(page.getByRole('status')).toHaveText('Draft saved.');
  await expect((await openPreview(page)).getByRole('heading', { level: 1 })).toHaveText('House rules');
  await gotoHydrated(page, '/admin/pages');
  await expect(languageCell(page, 'Community rules', 'en')).toContainText('Unpublished changes');
  const { context, page: reader } = await visitor(browser);
  await gotoHydrated(reader, '/rules');
  await expect(reader.getByRole('heading', { level: 1 })).toHaveText('Community rules');
  await context.close();
});

test('a German version published beside it is what a German browser reads, with lang set; English keeps the English text', async ({
  browser,
}) => {
  await gotoHydrated(page, '/admin/pages/rules/de');
  await page.getByLabel('Title').fill('Community-Regeln');
  await page.getByLabel('Markdown').fill('Stand: {{EFFECTIVE_DATE}}.\n\nSei freundlich. Kontakt: {{CONTACT_EMAIL}}.');
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.waitForURL(/saved=published/);
  const german = await visitor(browser, 'de-DE');
  const console = recordConsole(german.page);
  await gotoHydrated(german.page, '/rules');
  await expect(german.page.getByRole('heading', { level: 1, name: 'Community-Regeln' })).toBeVisible();
  await expect(german.page.locator('article')).toHaveAttribute('lang', 'de');
  await expect(german.page.locator('article')).toContainText('hello@operator.test');
  await expect(german.page.getByRole('navigation', { name: 'Rechtliches und Sicherheit' })).toBeVisible();
  await expectAccessible(german.page);
  expect(console.hydrationProblems()).toEqual([]);
  await german.context.close();
  const english = await visitor(browser);
  await gotoHydrated(english.page, '/rules');
  await expect(english.page.getByRole('heading', { level: 1 })).toHaveText('Community rules');
  await english.context.close();
});

test('the admin pages are German for a German browser too', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'de-DE', storageState: await page.context().storageState() });
  const de = await context.newPage();
  const console = recordConsole(de);
  await gotoHydrated(de, '/admin/pages');
  await expect(de.getByRole('heading', { level: 1, name: 'Seiten' })).toBeVisible();
  await expect(languageCell(de, 'Community-Regeln', 'de')).toContainText('Veröffentlicht');
  await expectAccessible(de);
  await gotoHydrated(de, '/admin/pages/rules/de');
  await expect(de.getByRole('button', { name: 'Veröffentlichen' })).toBeVisible();
  await expectAccessible(de);
  expect(console.hydrationProblems()).toEqual([]);
  await context.close();
});

test('unpublishing takes the page off the site and keeps the draft', async ({ browser }) => {
  await gotoHydrated(page, '/admin/pages/rules/de');
  await page.getByRole('button', { name: 'Unpublish' }).click();
  await page.waitForURL(/saved=unpublished/);
  await gotoHydrated(page, rules);
  await page.getByRole('button', { name: 'Unpublish' }).click();
  await page.waitForURL(/saved=unpublished/);
  await expect(page.getByLabel('Title')).toHaveValue('House rules');
  const { context, page: reader } = await visitor(browser);
  expect((await reader.goto('/rules'))?.status()).toBe(404);
  await context.close();
  await gotoHydrated(page, '/admin/pages');
  await expect(languageCell(page, 'Community rules', 'en')).toContainText('Draft');
});

test('with no About page, /about shows the name and description from Settings, in English and German', async ({ browser }) => {
  await gotoHydrated(page, '/admin/settings');
  await page.getByLabel('Site name').fill('About Feddit');
  await page.getByLabel('Description').fill('A quiet place.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(/saved=/);
  for (const [locale, heading] of [
    ['en-US', 'About About Feddit'],
    ['de-DE', 'Über About Feddit'],
  ] as const) {
    const { context, page: reader } = await visitor(browser, locale);
    const console = recordConsole(reader);
    await gotoHydrated(reader, '/about');
    await expect(reader.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(reader.getByText('A quiet place.')).toBeVisible();
    await expectAccessible(reader);
    expect(console.hydrationProblems()).toEqual([]);
    await context.close();
  }
});

test('a member without the admin role is turned away from the list and the editor, and an unknown page is a 404', async ({ browser }) => {
  const context = await browser.newContext();
  const member = await context.newPage();
  await member.goto('/auth/sign-in');
  await member.getByLabel('Email or handle').fill(`@${account.name}`);
  await member.getByLabel('Password', { exact: true }).fill(account.password);
  await member.getByRole('button', { name: 'Sign in' }).click();
  await member.waitForURL('/');
  await member.goto('/admin/pages');
  await expect(member.getByRole('alert')).toHaveText('Only site admins can use this page.');
  await member.goto(rules);
  await expect(member.getByRole('alert')).toHaveText('Only site admins can use this page.');
  expect((await member.goto('/admin/pages/rules/fr'))?.status()).toBe(404);
  expect((await member.goto('/admin/pages/nope/en'))?.status()).toBe(404);
  await context.close();
});
