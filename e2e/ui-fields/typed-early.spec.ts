import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { landed } from '../auth/support.ts';
import { seedWorld, signedIn, signedInAdmin, type World } from '../modlog/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// What a person types into a server-rendered field before the page has hydrated is kept. React
// Aria holds a text field's value in its own state, which starts from the server's value and never
// hears of keystrokes made before the scripts ran; the field renders again straight after
// hydration, and that render used to write the empty value back over the text (the Bans tab's
// Reason on Linux CI: the ban was never posted). A fast person, or a slow network, gets there:
// the page is on screen and editable well before its scripts have run.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ timeout: 90_000 });

let world: World;
test.beforeAll(() => {
  world = seedWorld();
});

/** Holds back every request to `pattern` until the returned function is called; later ones pass at once. */
async function hold(page: Page, pattern: string): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const wait = async (route: Route) => {
    await gate;
    await route.continue();
  };
  await page.route(pattern, wait);
  return release;
}

const hydrated = (page: Page) => page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
const notHydrated = async (page: Page) => expect(await page.evaluate(() => document.documentElement.dataset.hydrated)).toBeUndefined();

async function pageAs(browser: Browser, who?: 'admin' | string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1400 } })).newPage();
  if (who === 'admin') await signedInAdmin(page, world);
  else if (who) await signedIn(page, world, who);
  return page;
}

test('the ban reason (text area) typed before the page hydrates, and while the counts arrive, is posted whole', async ({ browser }) => {
  const page = await pageAs(browser, 'admin');
  await gotoHydrated(page, '/admin/bans');
  await page.getByLabel('Ban someone').fill(`@${world.spammer.name}`);
  // The confirmation is a page of its own: its scripts, then the counts it asks for, come late.
  const scripts = await hold(page, '**/assets/**/*.js');
  const counts = await hold(page, '**/_serverFn/**');
  await page.getByRole('button', { name: 'Check' }).click();
  const confirm = page.getByTestId('ban-confirm');
  const reason = confirm.getByRole('textbox', { name: 'Reason' });
  await reason.pressSequentially('Spam');
  await notHydrated(page);
  scripts();
  await hydrated(page);
  await expect(reason).toHaveValue('Spam');
  // Hydrated, with the counts still on their way.
  await reason.press('End');
  await reason.pressSequentially(' links');
  counts();
  await expect(confirm.getByRole('checkbox', { name: /Also remove their content \(posts: \d+/ })).toBeAttached();
  await expect(reason).toHaveValue('Spam links');
  const posted = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/modlog/act'));
  await confirm.getByRole('button', { name: 'Ban', exact: true }).click();
  expect(new URLSearchParams((await posted).postData() ?? '').get('reason')).toBe('Spam links');
  await expect(page.getByRole('row').filter({ hasText: world.spammer.name })).toContainText('Spam links');
  await page.context().close();
});

test('sign-in (text inputs) typed before the page hydrates signs in', async ({ browser }) => {
  const page = await pageAs(browser);
  const scripts = await hold(page, '**/assets/**/*.js');
  await page.goto('/auth/sign-in', { waitUntil: 'commit' });
  await page.getByLabel('Email or handle').pressSequentially(`@${world.bystander.name}`);
  await page.getByLabel('Password', { exact: true }).pressSequentially(world.password);
  await notHydrated(page);
  scripts();
  await hydrated(page);
  await expect(page.getByLabel('Email or handle')).toHaveValue(`@${world.bystander.name}`);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue(world.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await landed(page, '/');
  await page.context().close();
});

test('a reply (a field its caller controls) typed before the page hydrates is posted whole', async ({ browser }) => {
  const page = await pageAs(browser, world.bystander.name);
  const scripts = await hold(page, '**/assets/**/*.js');
  await page.goto(`/post/${world.posts.author}`, { waitUntil: 'commit' });
  const bar = page.getByRole('form', { name: 'Reply' });
  const text = bar.getByRole('textbox', { name: 'Reply' });
  await text.pressSequentially('Typed early');
  await notHydrated(page);
  scripts();
  await hydrated(page);
  await expect(text).toHaveValue('Typed early');
  await text.press('End');
  await text.pressSequentially(', kept');
  await bar.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.locator('article, li').filter({ hasText: 'Typed early, kept' }).first()).toBeVisible();
  await expect(text).toHaveValue('');
  await page.context().close();
});
