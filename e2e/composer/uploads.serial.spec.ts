import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type BrowserContext } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';
import { community, seed, setUploads, signedIn, type Seed } from './support.ts';

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
  await community(page, world.communities.open.handle).check();
  await page.locator('label.cmp__type', { hasText: 'Image' }).click();
  await expect(page.getByLabel('Image file')).toBeVisible();
  await page.getByLabel('Title').fill('An uploaded image');
  await page.getByLabel('Alt text').fill('A single red pixel');

  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByText('Choose an image to upload.')).toBeVisible();

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
