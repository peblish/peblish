import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';
import { choose, chooseType, seed, type Seed, setUploads, signedIn } from './support.ts';

// The Image type: disabled, with its reason, while uploads.enabled is off (the default until
// scanning is live), and a working upload path behind the switch. The spec flips the switch on
// the lane database and puts it back; it is the only composer spec that does, so the others
// never look at the Image type.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

/** A 1x1 PNG, built here so the test carries no binary file. */
function png(): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(name), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Drops a PNG named `name` on the image field's drop zone, as a drag from the desktop does. */
async function drop(page: Page, name: string) {
  const dataTransfer = await page.evaluateHandle(
    ([name, bytes]) => {
      // A DataTransfer made by a script has no file-system entry for its files, and React Aria
      // skips a dropped file without one; a real drag from the desktop has it.
      DataTransferItem.prototype.webkitGetAsEntry = function () {
        return this.kind === 'file' ? ({ isFile: true, isDirectory: false } as FileSystemEntry) : null;
      };
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(bytes!), (char) => char.charCodeAt(0))], name!, { type: 'image/png' }));
      return transfer;
    },
    [name, png().toString('base64')],
  );
  const zone = page.locator('.cmp__drop');
  for (const type of ['dragenter', 'dragover', 'drop']) await zone.dispatchEvent(type, { dataTransfer });
}

/** The name of the file the form's own image field holds, or null. */
const held = (page: Page) => page.locator('input[name="image"]').evaluate((input: HTMLInputElement) => input.files?.[0]?.name ?? null);

let world: Seed;
let poster: BrowserContext;

test.beforeAll(async ({ browser, baseURL }) => {
  setUploads(false);
  world = seed();
  poster = await signedIn(browser, baseURL!, world.people.poster, world.password);
});
test.afterAll(async () => {
  setUploads(false);
  await poster.close();
});

test('while uploads are off the Image type is disabled, says why, and the server refuses a file', async () => {
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  await expect(page.getByRole('radio', { name: 'Image' })).toBeDisabled();
  await expect(page.getByText('Image posts are off until media scanning is live. Use a link post for now.')).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  const answer = await page.evaluate(
    async ([id, bytes]) => {
      const form = new FormData();
      form.set('community', id!);
      form.set('type', 'image');
      form.set('title', 'Sneaking an image in');
      form.set('image', new Blob([Uint8Array.from(atob(bytes!), (char) => char.charCodeAt(0))], { type: 'image/png' }), 'a.png');
      const response = await fetch('/submit', { method: 'POST', body: form, headers: { accept: 'application/json' } });
      return { status: response.status, body: (await response.json()) as unknown };
    },
    [world.communities.open.id, png().toString('base64')],
  );
  expect(answer).toEqual({ status: 400, body: { error: 'site.disabled' } });
  await page.close();
});

test('with uploads on an image is cleaned, stored and posted, and a bad file is refused by reason', async () => {
  setUploads(true);
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  await expect(page.getByRole('radio', { name: 'Image' })).toBeEnabled();
  await choose(page, world.communities.open.handle);
  await chooseType(page, 'Image');
  await expect(page.getByLabel('Image file')).toBeVisible();
  await page.getByLabel('Title').fill('An uploaded image');
  await page.getByLabel('Alt text').fill('A single red pixel');

  await page.getByRole('button', { name: 'Post', exact: true }).click();
  // Announced, and still the field's description.
  await expect(page.getByRole('alert')).toHaveText('Choose an image to upload.');
  await expect(page.getByLabel('Image file')).toHaveAccessibleDescription(/Choose an image to upload\./);

  await page.getByLabel('Image file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByText('Only JPEG, PNG, WebP and GIF images can be uploaded.')).toBeVisible();

  await page.getByLabel('Image file').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(11 * 1024 * 1024, 1) });
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByText('That image is too large.')).toBeVisible();

  await page.getByLabel('Image file').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png() });
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('An uploaded image');
  // The post links the stored image on this instance; nothing serves it until the scanning lane lands.
  await expect(page.locator('.post-image img')).toHaveAttribute('src', /\/media\/[0-9a-f-]{36}$/);
  await page.close();
});

test('a dropped image stays in the form while other fields change, also after one was picked, and posts', async () => {
  setUploads(true);
  const page = await poster.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await gotoHydrated(page, '/submit');
  await choose(page, world.communities.open.handle);
  await chooseType(page, 'Image');
  await drop(page, 'dropped.png');
  await expect.poll(() => held(page)).toBe('dropped.png');
  await page.getByLabel('Title').fill('A dropped image');
  await page.getByLabel('Alt text').fill('Dropped, then the words');
  expect(await held(page)).toBe('dropped.png');

  // Picked first, then another dropped over it: the dropped one is kept, and nothing throws.
  await page.getByLabel('Image file').setInputFiles({ name: 'picked.png', mimeType: 'image/png', buffer: png() });
  await page.getByLabel('Alt text').fill('Picked');
  expect(await held(page)).toBe('picked.png');
  await drop(page, 'second.png');
  await expect.poll(() => held(page)).toBe('second.png');
  await page.getByLabel('Alt text').fill('Picked, then dropped over');
  await page.getByLabel('Title').fill('A dropped image, kept');
  expect(await held(page)).toBe('second.png');
  expect(errors).toEqual([]);

  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('A dropped image, kept');
  await expect(page.locator('.post-image img')).toHaveAttribute('src', /\/media\/[0-9a-f-]{36}$/);
  expect(errors).toEqual([]);
  await page.close();
});

test('alt text over 1,000 characters is told beside the field, and the server refuses it by its code', async ({ browser, baseURL }) => {
  setUploads(true);
  const message = 'The alt text can have up to 1,000 characters.';
  const page = await poster.newPage();
  await gotoHydrated(page, '/submit');
  await choose(page, world.communities.open.handle);
  await chooseType(page, 'Image');
  await page.getByLabel('Title').fill('A long description');
  await page.getByLabel('Image file').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png() });
  const alt = page.getByLabel('Alt text');
  await alt.fill('a'.repeat(1_001));
  // Shown while typing, as the field's description and as an alert; the form does not send.
  await expect(page.getByText(message)).toBeVisible();
  await expect(alt).toHaveAccessibleDescription(new RegExp(message.replace('.', '\\.')));
  await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(1);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page).toHaveURL(/\/submit$/);
  await page.close();

  // Without scripts the server says the same, and was cutting the text short before.
  const plain = await browser.newContext({ baseURL, javaScriptEnabled: false, storageState: await poster.storageState() });
  const form = await plain.newPage();
  await form.goto('/submit');
  await choose(form, world.communities.open.handle);
  await chooseType(form, 'Image');
  await form.getByLabel('Title').fill('A long description');
  await form.getByLabel('Image file').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png() });
  await form.getByLabel('Alt text').fill('a'.repeat(1_001));
  await form.getByRole('button', { name: 'Post', exact: true }).click();
  await form.waitForURL(/\/submit\?.*error=alt\.too_long/);
  await expect(form.getByText(message)).toBeVisible();
  await expect(form.getByLabel('Alt text')).toHaveValue('a'.repeat(1_001));
  await plain.close();
});

test('an image posts with scripts off, as a plain form', async ({ browser, baseURL }) => {
  setUploads(true);
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email or handle').fill(`@${world.people.poster}`);
  await page.getByLabel('Password', { exact: true }).fill(world.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
  await page.goto('/submit');
  await choose(page, world.communities.open.handle);
  await chooseType(page, 'Image');
  await expect(page.getByLabel('Image file')).toBeVisible();
  await page.getByLabel('Title').fill('An image without JavaScript');
  await page.getByLabel('Alt text').fill('A red pixel, posted plainly');
  await page.getByLabel('Image file').setInputFiles({ name: 'plain.png', mimeType: 'image/png', buffer: png() });
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('An image without JavaScript');
  await expect(page.locator('.post-image img')).toHaveAttribute('src', /\/media\/[0-9a-f-]{36}$/);
  await context.close();
});
