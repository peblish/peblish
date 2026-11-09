import { expect, test, type Page } from '@playwright/test';
import { seed, type Seed } from './support.ts';

// The composer without JavaScript: a plain form post to /submit. The post types switch their
// fields by CSS alone, a post lands on its page, and a refusal comes back as a 303 to the form
// with the reason in the URL and everything that was typed kept.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.use({ javaScriptEnabled: false });

let world: Seed;
test.beforeAll(() => {
  world = seed();
});

async function signIn(page: Page, name: string) {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email or handle').fill(`@${name}`);
  await page.getByLabel('Password', { exact: true }).fill(world.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

test('a text post, a link post and the type switch work without JavaScript', async ({ page }) => {
  await signIn(page, world.people.poster);
  await page.goto('/submit');
  // The enhancements wait for JavaScript, which is not coming.
  await expect(page.getByRole('button', { name: 'Preview' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Bold' })).toBeDisabled();
  await expect(page.getByRole('radio', { name: 'Image' })).toBeDisabled();
  // Text: the address field is hidden; Link: the body is.
  await expect(page.getByLabel('URL')).toBeHidden();
  await page.locator('label.cmp__type', { hasText: 'Link' }).click();
  await expect(page.getByLabel('URL')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Body', exact: true })).toBeHidden();
  await page.locator('label.cmp__type', { hasText: 'Text' }).click();
  await expect(page.getByLabel('URL')).toBeHidden();

  await page.locator('label.cmp__row', { hasText: world.communities.open.handle }).click();
  await page.getByLabel('Title').fill('Posted without JavaScript');
  await page.getByRole('textbox', { name: 'Body', exact: true }).fill('Line one\n\nLine **two**');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Posted without JavaScript');
  await expect(page.locator('.post-text strong')).toHaveText('two');

  await page.goto('/submit');
  await page.locator('label.cmp__row', { hasText: world.communities.open.handle }).click();
  await page.locator('label.cmp__type', { hasText: 'Link' }).click();
  await page.getByLabel('Title').fill('A link without JavaScript');
  await page.getByLabel('URL').fill('https://example.test/no-js');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('link', { name: 'example.test' })).toHaveAttribute('href', 'https://example.test/no-js');
});

test('a refusal comes back to the form by its reason, with what was typed', async ({ page }) => {
  await signIn(page, world.people.banned);
  await page.goto('/submit');
  await page.locator('label.cmp__row', { hasText: world.communities.closed.handle }).click();
  await page.getByLabel('Title').fill('Turned away');
  await page.getByRole('textbox', { name: 'Body', exact: true }).fill('Still here\n\nafter the refusal');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/submit\?.*error=community\.banned/);
  await expect(page.getByRole('alert')).toHaveText('You are banned from this community.');
  await expect(page.getByLabel('Title')).toHaveValue('Turned away');
  await expect(page.getByRole('textbox', { name: 'Body', exact: true })).toHaveValue('Still here\n\nafter the refusal');
  await expect(page.locator('input[name="community"]:checked')).toHaveValue(world.communities.closed.id);
  // The community chosen is the one the rules aside shows.
  await expect(page.getByRole('complementary', { name: 'Community rules' })).toContainText(world.communities.closed.handle);
});

test('a long body is kept through a refusal, and the words are not in the URL', async ({ page }) => {
  await signIn(page, world.people.banned);
  await page.goto('/submit');
  await page.locator('label.cmp__row', { hasText: world.communities.closed.handle }).click();
  await page.getByLabel('Title').fill('Turned away again');
  // Far more than a URL carries.
  const long = Array.from({ length: 1_500 }, (_, index) => `line ${index} with a few words`).join('\n');
  await page.getByRole('textbox', { name: 'Body', exact: true }).fill(long);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/submit\?.*error=community\.banned/);
  expect(page.url()).not.toContain('line');
  expect(page.url().length).toBeLessThan(300);
  await expect(page.getByRole('textbox', { name: 'Body', exact: true })).toHaveValue(long);
});

test('a refused edit comes back with what was typed over the saved post', async ({ page }) => {
  await signIn(page, world.people.poster);
  await page.goto('/submit');
  await page.locator('label.cmp__row', { hasText: world.communities.open.handle }).click();
  await page.getByLabel('Title').fill('Saved title');
  await page.getByRole('textbox', { name: 'Body', exact: true }).fill('Saved body');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').at(-1)!;

  await page.goto(`/submit?edit=${id}`);
  await expect(page.getByLabel('Title')).toHaveValue('Saved title');
  const tooLong = 'T'.repeat(201);
  const edited = Array.from({ length: 400 }, (_, index) => `edit ${index}`).join(' ');
  await page.getByLabel('Title').fill(tooLong);
  await page.getByRole('textbox', { name: 'Body', exact: true }).fill(edited);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(/\/submit\?.*error=title\.too_long/);
  expect(new URL(page.url()).searchParams.get('edit')).toBe(id);
  await expect(page.getByLabel('Title')).toHaveValue(tooLong);
  await expect(page.getByRole('textbox', { name: 'Body', exact: true })).toHaveValue(edited);
  // The saved post is untouched.
  await page.goto(`/post/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Saved title');
});

test('someone else does not get the words from a refusal link', async ({ page, browser, baseURL }) => {
  await signIn(page, world.people.banned);
  await page.goto('/submit');
  await page.locator('label.cmp__row', { hasText: world.communities.closed.handle }).click();
  await page.getByLabel('Title').fill('Private title');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/submit\?.*error=community\.banned/);
  const link = page.url();
  await expect(page.getByLabel('Title')).toHaveValue('Private title');

  const other = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const second = await other.newPage();
  await signIn(second, world.people.poster);
  await second.goto(link);
  await expect(second.getByLabel('Title')).toHaveValue('');
  await other.close();
});

test('a missing title comes back by its code, beside the field', async ({ page }) => {
  await signIn(page, world.people.poster);
  await page.goto('/submit');
  await page.locator('label.cmp__row', { hasText: world.communities.open.handle }).click();
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/submit\?.*error=title\.required/);
  await expect(page.getByText('Add a title.')).toBeVisible();
});

test('signed out, the composer sends you to sign in and back', async ({ page }) => {
  await page.goto('/submit');
  await expect(page).toHaveURL(/\/auth\/sign-in\?redirect=%2Fsubmit/);
});

test('a post sent after the session ended goes to sign-in and back to a form with no refusal in it', async ({ page, context }) => {
  await signIn(page, world.people.poster);
  await page.goto('/submit');
  await page.locator('label.cmp__row', { hasText: world.communities.open.handle }).click();
  await page.getByLabel('Title').fill('Written while the session ended');
  await context.clearCookies();
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/auth\/sign-in\?/);
  expect(page.url()).not.toMatch(/auth\.required|error/);
  await page.getByLabel('Email or handle').fill(`@${world.people.poster}`);
  await page.getByLabel('Password', { exact: true }).fill(world.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/submit$/);
  // The form again, with nothing refused and no message.
  await expect(page.getByRole('heading', { level: 1, name: 'Create post' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
