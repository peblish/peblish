import { createHash } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance, seedSetting } from '../testing/seed-a.ts';
import { outboxEvents } from '../testing/seed-az.ts';
import { localUser } from '../testing/seed.ts';
import { memoryStore } from '../storage/memory.ts';
import type { ObjectStore } from '../storage/store.ts';
import { bytes } from './__fixtures__/images.ts';
import { dirtyJpeg, has, secret } from './__fixtures__/dirty.ts';
import { maxUploadBytes } from './save.ts';
import { uploadImage } from './upload.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

async function uploader(options: { emailVerified?: boolean } = {}) {
  const account = await seedAccount('uploader', options);
  return localUser(account.actorId);
}
const mediaRows = () => db().select().from(media);

test('uploads are refused with site.disabled while the flag is off, before the file is read', async () => {
  const store = memoryStore();
  const principal = await uploader();
  // Not even an image: the switch is checked first.
  expect(await uploadImage(principal, { bytes: Buffer.from('not an image') }, { store })).toEqual({ ok: false, reason: 'site.disabled' });
  await seedSetting('uploads.enabled', false);
  expect(await uploadImage(principal, { bytes: bytes('png') }, { store })).toEqual({ ok: false, reason: 'site.disabled' });
  expect([store.objects.size, (await mediaRows()).length, await outboxEvents()]).toEqual([0, 0, []]);
});

test('an upload is cleaned, stored, recorded pending, and announced for the scanner', async () => {
  await seedSetting('uploads.enabled', true);
  const store = memoryStore();
  const principal = await uploader();
  const result = await uploadImage(principal, { bytes: dirtyJpeg(6), altText: 'a gradient' }, { store });
  if (!result.ok) throw new Error(result.reason);

  const stored = store.objects.get(result.storageKey);
  expect(stored?.contentType).toBe('image/jpeg');
  // EXIF stripped: the GPS position, the camera and the owner are not in the stored object.
  expect(has(stored?.body ?? new Uint8Array(), secret)).toBe(false);
  expect(has(stored?.body ?? new Uint8Array(), 'Exif')).toBe(true); // only the orientation, 34 bytes
  expect(result.storageKey).toMatch(/^media\/[0-9a-f-]{36}\.jpg$/);

  const [row] = await mediaRows();
  expect(row).toMatchObject({
    id: result.id,
    ownerId: principal.actorId,
    kind: 'upload',
    storageKey: result.storageKey,
    mimeType: 'image/jpeg',
    byteSize: stored?.body.byteLength,
    width: 24,
    height: 16,
    altText: 'a gradient',
    scanState: 'pending',
    scannedAt: null,
  });
  expect(row?.sha256).toBe(
    createHash('sha256')
      .update(stored?.body ?? new Uint8Array())
      .digest('hex'),
  );
  expect(await outboxEvents()).toEqual([{ type: 'media.stored', v: 1, mediaId: result.id, ownerId: principal.actorId, kind: 'upload' }]);
});

test('SVG, damaged files and oversize files are refused with their own reasons and leave nothing behind', async () => {
  await seedSetting('uploads.enabled', true);
  const store = memoryStore();
  const principal = await uploader();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const png = bytes('png');
  const cases = [
    [svg, 'media.unsupported_type'],
    [bytes('jpeg').subarray(0, 300), 'media.invalid_image'],
    [Buffer.alloc(maxUploadBytes + 1, 0xff), 'media.too_large'],
    [png.subarray(0, 40), 'media.invalid_image'],
  ] as const;
  for (const [input, reason] of cases)
    expect(await uploadImage(principal, { bytes: input }, { store }), reason).toEqual({ ok: false, reason });
  expect([store.objects.size, (await mediaRows()).length, await outboxEvents()]).toEqual([0, 0, []]);
});

test('an account with an unverified email, or no login at all, cannot upload', async () => {
  await seedSetting('uploads.enabled', true);
  const store = memoryStore();
  const unverified = await uploader({ emailVerified: false });
  expect(await uploadImage(unverified, { bytes: bytes('png') }, { store })).toEqual({ ok: false, reason: 'auth.email_unverified' });
  expect(await uploadImage({ kind: 'anonymous' }, { bytes: bytes('png') }, { store })).toEqual({ ok: false, reason: 'auth.required' });
  expect(store.objects.size).toBe(0);
});

test('a switch flipped after authorize() is honoured by the write, and the stored object is taken back', async () => {
  await seedSetting('uploads.enabled', true);
  const memory = memoryStore();
  // The flag goes off while the object is being put.
  const racing: ObjectStore = {
    ...memory,
    put: async (key, body, contentType) => {
      await memory.put(key, body, contentType);
      await seedSetting('uploads.enabled', false);
    },
  };
  expect(await uploadImage(await uploader(), { bytes: bytes('png') }, { store: racing })).toEqual({ ok: false, reason: 'site.disabled' });
  expect([memory.objects.size, (await mediaRows()).length, await outboxEvents()]).toEqual([0, 0, []]);
});
