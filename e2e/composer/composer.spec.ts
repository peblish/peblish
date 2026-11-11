import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectAccessible, landed, signIn } from '../auth/support.ts';
import { gotoHydrated, recordConsole } from '../support/route-marker.ts';
import { choose, chooseType, community, radioLabel, seed, type Seed, signedIn } from './support.ts';
import { siteName } from '../support/site-name.ts';

// The composer as a page, end to end on the built server and the lane database: the picker and
// the community's rules, the editor's toolbar, the refusals by reason, drafts and the author's
// edit. The steps share seeded accounts and communities, so they run in order. The sheet,
// no-JavaScript posting, uploads, Preview against what is published (preview.serial.spec.ts)
// and the payload have their own specs.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let world: Seed;
let poster: BrowserContext;
let moderator: BrowserContext;
let unverified: BrowserContext;
let banned: BrowserContext;
let young: BrowserContext;

test.beforeAll(async ({ browser, baseURL }) => {
  world = seed();
  const { password, people } = world;
  [poster, moderator, unverified, banned, young] = await Promise.all([
    signedIn(browser, baseURL!, people.poster, password),
    signedIn(browser, baseURL!, people.moderator, password),
    signedIn(browser, baseURL!, people.unverified, password),
    signedIn(browser, baseURL!, people.banned, password),
    signedIn(browser, baseURL!, people.young, password),
  ]);
});
test.afterAll(async () => {
  await Promise.all([poster, moderator, unverified, banned, young].map((context) => context.close()));
});

const body = (page: Page) => page.getByRole('textbox', { name: 'Body', exact: true });
const post = (page: Page) => page.getByRole('button', { name: 'Post', exact: true });

/** The Markdown body of a new post, with the community chosen and a title; what each test then does with it differs. */
async function fill(page: Page, handle: string, title: string, text: string) {
  await choose(page, handle);
  await page.getByLabel('Title').fill(title);
  await body(page).fill(text);
}

test('the page hydrates, lists the communities and has no axe violations', async () => {
  const page = await poster.newPage();
  const log = recordConsole(page);
  await gotoHydrated(page, '/submit');
  await expect(page.getByRole('heading', { level: 1, name: 'Create post' })).toBeVisible();
  await expect(page).toHaveTitle(`Create post \u00b7 ${await siteName(page)}`);
  // Local communities, and the remote one the person follows.
  await expect(community(page, world.communities.open.handle)).toBeEnabled();
  await expect(community(page, world.communities.remote.handle)).toBeEnabled();
  // A community restricted to moderators is disabled for a plain account, with the reason beside it.
  await expect(community(page, world.communities.staff.handle)).toBeDisabled();
  await expect(page.getByText('posting disabled for you').first()).toBeVisible();
  await expect(page.getByText(`Posting as @${world.people.poster}@`)).toBeVisible();
  await expectAccessible(page);
  expect(log.hydrationProblems()).toEqual([]);
  await page.close();
});

test('the picker leaves out removed communities, hides age-gated ones from someone without a 16+ declaration and disables a remote mods-only one', async () => {
  const { open, remote, adult, gated, gone, remoteStaff } = world.communities;
  const declared = await poster.newPage();
  await gotoHydrated(declared, '/submit');
  await expect(community(declared, adult.handle)).toBeEnabled();
  await expect(community(declared, gated.handle)).toBeEnabled();
  await expect(community(declared, gone.handle)).toHaveCount(0);
  // A remote community's own restriction applies as it does for a local one, and its handle has the host.
  await expect(community(declared, remoteStaff.handle)).toBeDisabled();
  // An NSFL community marks every post sensitive, as an NSFW one does.
  await choose(declared, gated.handle);
  await expect(declared.getByRole('checkbox', { name: 'NSFW' })).toBeChecked();
  await expect(declared.getByRole('checkbox', { name: 'NSFW' })).toBeDisabled();
  await declared.close();

  const minor = await young.newPage();
  await gotoHydrated(minor, '/submit');
  await expect(community(minor, open.handle)).toBeEnabled();
  await expect(community(minor, remote.handle)).toBeEnabled();
  for (const hidden of [adult, gated, gone]) await expect(community(minor, hidden.handle)).toHaveCount(0);
  await expect(community(minor, remoteStaff.handle)).toBeDisabled();
  // Asking for one by name does not start its panel either.
  await gotoHydrated(minor, `/submit?community=${adult.handle}`);
  await expect(minor.getByRole('complementary', { name: 'Community rules' })).toContainText('Choose a community');
  await minor.close();
});

test('the panel does not exist for an age-gated community when the viewer has not declared 16+', async () => {
  const { open, adult, gated } = world.communities;
  /** Chooses `open` in the picker, then asks for another community's panel the way the page does. */
  async function askPanel(page: Page) {
    const call = page.waitForRequest((request) => request.url().includes('/_serverFn/') && request.url().includes(open.id));
    await choose(page, open.handle);
    const url = (await call).url();
    await expect(page.getByRole('complementary', { name: 'Community rules' })).toContainText(open.handle);
    return (id: string) =>
      page.evaluate(
        async (target) => {
          const response = await fetch(target);
          return { status: response.status, text: await response.text() };
        },
        url.replace(open.id, id),
      );
  }

  const minor = await young.newPage();
  await gotoHydrated(minor, '/submit');
  const askAsMinor = await askPanel(minor);
  // The call succeeds and carries no panel, so nothing says the community is there.
  for (const gate of [adult, gated]) {
    const answer = await askAsMinor(gate.id);
    expect(answer.status).toBe(200);
    expect(answer.text).not.toContain(gate.handle.split('@')[0]);
  }
  await minor.close();

  const declared = await poster.newPage();
  await gotoHydrated(declared, '/submit');
  const askAsDeclared = await askPanel(declared);
  // The same call for someone who declared 16+ answers with the panel.
  expect((await askAsDeclared(adult.id)).text).toContain(adult.handle);
  await declared.close();
});

test('a moderator can pick the restricted community', async () => {
  const page = await moderator.newPage();
  await gotoHydrated(page, '/submit');
  await expect(community(page, world.communities.staff.handle)).toBeEnabled();
  await page.close();
});

test('the chosen community shows its rules and posting warning beside the form', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  const aside = page.getByRole('complementary', { name: 'Community rules' });
  await expect(aside).toContainText('Choose a community');
  await choose(page, world.communities.open.handle);
  await expect(aside.getByRole('heading', { level: 2 })).toContainText(world.communities.open.handle);
  await expect(aside).toContainText('Read the rules before you post.');
  await expect(aside.getByRole('listitem')).toHaveCount(2);
  await expect(aside.getByText('Be civil')).toBeVisible();
  await expect(aside.getByText('Stay on topic')).toBeVisible();
  // The filter narrows the list and never drops the chosen community from the form.
  await page.getByRole('searchbox', { name: 'Search communities' }).fill('tech_');
  await expect(community(page, world.communities.open.handle)).toHaveCount(0);
  await expect(radioLabel(community(page, world.communities.remote.handle))).toBeVisible();
  await expect(page.locator('input[name="community"]:checked')).toHaveValue(world.communities.open.id);
  await page.close();
});

test('the toolbar inserts Markdown at the selection, with a shortcut, and Undo still works', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  const text = body(page);
  await text.fill('make this bold');
  await text.evaluate((area: HTMLTextAreaElement) => area.setSelectionRange(5, 9));
  await page.getByRole('button', { name: 'Bold' }).click();
  await expect(text).toHaveValue('make **this** bold');
  // The browser's own Undo, not just the field's value, takes the edit back.
  await text.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(text).toHaveValue('make this bold');
  // A shortcut, and a button that needs a title: the caret lands where the next typing goes.
  await text.evaluate((area: HTMLTextAreaElement) => area.setSelectionRange(0, 4));
  await page.keyboard.press('ControlOrMeta+i');
  await expect(text).toHaveValue('*make* this bold');
  await text.fill('');
  await page.getByRole('button', { name: 'Spoiler block' }).click();
  await expect(text).toHaveValue('::: spoiler Spoiler\n\n:::');
  await page.close();
});

test('editing: the author changes the post, and Preview already carries the published footnote ids', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  await fill(page, world.communities.open.handle, 'Before the edit', 'First[^1] version.\n\n[^1]: The note.');
  await post(page).click();
  await page.waitForURL(/\/post\//);
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.waitForURL(/\/submit\?edit=/);
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await expect(page).toHaveTitle(`Edit post \u00b7 ${await siteName(page)}`);
  await expect(page.getByLabel('Title')).toHaveValue('Before the edit');
  await expect(body(page)).toHaveValue('First[^1] version.\n\n[^1]: The note.');
  await expect(page.getByText(`Editing a post in !${world.communities.open.handle}`)).toBeVisible();
  // The type and the community are fixed.
  await expect(page.getByRole('radio', { name: 'Link' })).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search communities' })).toHaveCount(0);
  await page.getByLabel('Title').fill('After the edit');
  await body(page).fill('Second[^1] version.\n\n[^1]: Another note.');
  await page.getByRole('radio', { name: 'Preview' }).click();
  const previewed = await page.locator('.pb-md__preview .pb-prose').innerHTML();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('After the edit');
  await expect(page.getByText('edited')).toBeVisible();
  expect(await page.locator('.post-text').innerHTML()).toBe(previewed);
  await page.close();
});

test('only the author can open the edit form', async () => {
  const author = await poster.newPage();
  await gotoHydrated(author, '/submit');
  await fill(author, world.communities.open.handle, 'Not yours to edit', '');
  await post(author).click();
  await author.waitForURL(/\/post\//);
  const id = author.url().split('/').at(-1)!;
  await author.close();
  const other = await moderator.newPage();
  await gotoHydrated(other, `/submit?edit=${id}`);
  await expect(other.getByRole('alert')).toHaveText('Only the author can edit this post.');
  await expect(other.getByLabel('Title')).toHaveCount(0);
  await other.close();
  const missing = await poster.newPage();
  await gotoHydrated(missing, '/submit?edit=0192f5a0-1234-7abc-8def-0123456789ab');
  await expect(missing.getByRole('alert')).toHaveText('This post no longer exists.');
  await missing.close();
});

test('a link post: a bad address is refused, a page that cannot be fetched gives no title to take, then the typed title posts', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  await choose(page, world.communities.open.handle);
  await chooseType(page, 'Link');
  // The text fields give way to the address field.
  await expect(page.getByLabel('URL')).toBeVisible();
  await expect(body(page)).toBeHidden();
  await page.getByLabel('URL').fill('not a link');
  await post(page).click();
  await expect(page.getByText('Enter a full web address')).toBeVisible();
  // example.test does not resolve, so there is no preview to take a title from.
  await page.getByLabel('URL').fill('https://example.test/article');
  await post(page).click();
  await expect(page.getByText('Add a title.')).toBeVisible();
  await expect(page).toHaveURL(/\/submit$/);
  await page.getByLabel('Title').fill('A link post');
  await post(page).click();
  await page.waitForURL(/\/post\//);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('A link post');
  await expect(page.getByRole('link', { name: 'example.test' })).toHaveAttribute('href', 'https://example.test/article');
  await page.close();
});

test('the title counts its characters and refuses more than 200', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  await page.getByLabel('Title').fill('x'.repeat(201));
  await expect(page.getByText('201 / 200')).toBeVisible();
  await choose(page, world.communities.open.handle);
  await post(page).click();
  await expect(page.getByText('The title can have up to 200 characters.')).toBeVisible();
  await page.getByLabel('Title').fill('x'.repeat(200));
  await expect(page.getByText('200 / 200')).toBeVisible();
  await page.close();
});

test('a refusal is shown by its reason, and what was typed stays', async () => {
  for (const [context, handle, message] of [
    [banned, world.communities.closed.handle, 'You are banned from this community.'],
    [unverified, world.communities.open.handle, 'Confirm your email address before you post.'],
  ] as const) {
    const page = await context.newPage();
    await gotoHydrated(page, '/submit');
    await fill(page, handle, 'Refused', 'Kept through the refusal');
    await post(page).click();
    await expect(page.getByRole('alert')).toContainText(message);
    await expect(page.getByLabel('Title')).toHaveValue('Refused');
    await expect(body(page)).toHaveValue('Kept through the refusal');
    await page.close();
  }
});

test('a restricted community starting the form says so, and the server refuses it by reason too', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, `/submit?community=${world.communities.staff.handle}`);
  await expect(page.getByRole('alert')).toHaveText('Only the moderators of this community can post in it.');
  await expect(post(page)).toBeDisabled();
  // The picker disables the row, so the form cannot name it; a request that does gets the exact reason.
  const answer = await page.evaluate(async (id) => {
    const form = new FormData();
    form.set('community', id);
    form.set('title', 'Sneaking in');
    const response = await fetch('/submit', { method: 'POST', body: form, headers: { accept: 'application/json' } });
    return { status: response.status, body: (await response.json()) as unknown };
  }, world.communities.staff.id);
  expect(answer).toEqual({ status: 400, body: { error: 'community.posting_restricted' } });
  await page.close();
});

test('a draft is kept in this browser per community, restored, and cleared by posting or discarding', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  await fill(page, world.communities.open.handle, 'A draft title', 'Draft body');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toHaveText('Draft saved in this browser.');
  // Another community has none; coming back to this one restores it.
  await page.reload();
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await expect(page.getByLabel('Title')).toHaveValue('');
  await choose(page, world.communities.remote.handle);
  await expect(page.getByLabel('Title')).toHaveValue('');
  await choose(page, world.communities.open.handle);
  await expect(page.getByLabel('Title')).toHaveValue('A draft title');
  await expect(body(page)).toHaveValue('Draft body');
  await expect(page.getByRole('status')).toHaveText('Your saved draft for this community is back.');
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.waitForURL('/');
  await gotoHydrated(page, '/submit');
  await choose(page, world.communities.open.handle);
  await expect(page.getByLabel('Title')).toHaveValue('');
  await page.close();
});

test("a draft is the signed-in person's: someone else on the same browser does not get it, and an unscoped one is removed", async ({
  browser,
  baseURL,
}) => {
  const { open } = world.communities;
  // One browser (one localStorage) that two people sign in to in turn.
  const shared = await signedIn(browser, baseURL!, world.people.poster, world.password);
  const page = await shared.newPage();
  const legacy = `peblish.draft.${open.id}`;
  await gotoHydrated(page, '/submit');
  await page.evaluate(
    ([key]) => localStorage.setItem(key!, JSON.stringify({ type: 'text', title: 'Unscoped', url: '', body: 'old', nsfw: false })),
    [legacy],
  );
  // The unscoped draft is never offered, and the next visit removes it.
  await gotoHydrated(page, '/submit');
  await choose(page, open.handle);
  await expect(page.getByLabel('Title')).toHaveValue('');
  expect(await page.evaluate((key) => localStorage.getItem(key), legacy)).toBeNull();

  await fill(page, open.handle, "Ann's draft", 'Private words');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toHaveText('Draft saved in this browser.');
  await page.reload();
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  await choose(page, open.handle);
  await expect(page.getByLabel('Title')).toHaveValue("Ann's draft");

  // The moderator signs in on the same browser: the draft stays with the poster.
  await shared.clearCookies();
  await gotoHydrated(page, '/auth/sign-in');
  await signIn(page, `@${world.people.moderator}`, world.password);
  await landed(page, '/');
  await gotoHydrated(page, '/submit');
  await choose(page, open.handle);
  await expect(page.getByLabel('Title')).toHaveValue('');
  await expect(body(page)).toHaveValue('');
  await expect(page.getByRole('status')).toHaveText('');
  await shared.close();
});
