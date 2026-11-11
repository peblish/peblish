import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';
import { choose, chooseType, seed, type Seed, signedIn } from './support.ts';

// What a person is told about a field the form will not send, with scripts on. Once hydrated,
// React Aria keeps the browser's own validation bubble away, so every check has to show its own
// message: beside the field, as the field's accessible description (read when the field is
// focused), and as an alert (read when it appears). The scripts-off checks are the server's
// refusals (nojs.spec.ts); the image and its alt text need uploads (uploads.serial.spec.ts).
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');

let world: Seed;
let poster: BrowserContext;
test.beforeAll(async ({ browser, baseURL }) => {
  world = seed();
  poster = await signedIn(browser, baseURL!, world.people.poster, world.password);
});
test.afterAll(async () => {
  await poster.close();
});

const post = (page: Page) => page.getByRole('button', { name: 'Post', exact: true });

/** The message is in sight, describes the field and is announced. */
async function told(field: Locator, page: Page, message: string) {
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(field).toHaveAccessibleDescription(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(1);
}

test('an empty or too long title is told beside the field', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  await choose(page, world.communities.open.handle);
  const title = page.getByLabel('Title');
  await post(page).click();
  await told(title, page, 'Add a title.');
  // Over the limit the message shows while typing, before anything is sent.
  await title.fill('x'.repeat(201));
  await told(title, page, 'The title can have up to 200 characters.');
  await post(page).click();
  await expect(page).toHaveURL(/\/submit$/);
  await told(title, page, 'The title can have up to 200 characters.');
  await page.close();
});

test('a missing or broken address is told beside the URL field', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  await choose(page, world.communities.open.handle);
  await chooseType(page, 'Link');
  const url = page.getByLabel('URL');
  await page.getByLabel('Title').fill('A link');
  await post(page).click();
  await told(url, page, 'Add the address of the link.');
  await url.fill('not a link');
  await post(page).click();
  await told(url, page, 'Enter a full web address that starts with http:// or https://.');
  await page.close();
});

test('a body over the limit is told beside the editor', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  await choose(page, world.communities.open.handle);
  await page.getByLabel('Title').fill('Too much to say');
  const body = page.getByRole('textbox', { name: 'Body', exact: true });
  await body.fill('w'.repeat(50_001));
  const message = 'The text is too long. Posts can have up to 50,000 characters.';
  await told(body, page, message);
  await post(page).click();
  await expect(page).toHaveURL(/\/submit$/);
  await told(body, page, message);
  await page.close();
});

test('the messages are in the page language: German', async ({ browser, baseURL }) => {
  const german = await browser.newContext({ baseURL, locale: 'de-DE', storageState: await poster.storageState() });
  const page = await german.newPage();
  await gotoHydrated(page, '/submit');
  const title = page.getByLabel('Titel');
  await title.fill('Ohne Community');
  await page.getByRole('button', { name: 'Posten', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Wähle eine Community zum Posten.');
  await choose(page, world.communities.open.handle);
  await title.fill('');
  await page.getByRole('button', { name: 'Posten', exact: true }).click();
  await told(title, page, 'Gib einen Titel ein.');
  await german.close();
});
