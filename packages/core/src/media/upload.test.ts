import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { writer } from '../db/write.ts';
import { mediaBlocklist } from '../mediascan/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance, seedSetting } from '../testing/seed-a.ts';
import { outboxEvents } from '../testing/seed-az.ts';
import { localUser } from '../testing/seed.ts';
import { memoryStore } from '../storage/memory.ts';
import type { ObjectStore } from '../storage/store.ts';
import { bytes } from './__fixtures__/images.ts';
import { dirtyJpeg, has, secret } from './__fixtures__/dirty.ts';
import { scanConfig } from '../mediascan/config.ts';
import { startArachnidStub } from '../testing/seed-safe.ts';
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
/** Scanning against the local list only: what development runs with, so these tests need no provider. */
const localScan = { config: scanConfig({ MEDIASCAN_LOCAL_ONLY: '1' }) };

test('uploads are refused with site.disabled while the flag is off, before the file is read', async () => {
  const store = memoryStore();
  const principal = await uploader();
  // Not even an image: the switch is checked first.
  expect(await uploadImage(principal, { bytes: Buffer.from('not an image') }, { store })).toEqual({ ok: false, reason: 'site.disabled' });
  await seedSetting('uploads.enabled', false);
  expect(await uploadImage(principal, { bytes: bytes('png') }, { store })).toEqual({ ok: false, reason: 'site.disabled' });
  expect([store.objects.size, (await mediaRows()).length, await outboxEvents()]).toEqual([0, 0, []]);
});

test('an upload is cleaned, stored, scanned inline and recorded clean, with both events', async () => {
  await seedSetting('uploads.enabled', true);
  const store = memoryStore();
  const principal = await uploader();
  const result = await uploadImage(principal, { bytes: dirtyJpeg(6), altText: 'a gradient' }, { store, scan: localScan });
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
    scanState: 'clean',
  });
  expect(row?.scannedAt).not.toBeNull();
  expect(row?.sha256).toBe(
    createHash('sha256')
      .update(stored?.body ?? new Uint8Array())
      .digest('hex'),
  );
  expect(await outboxEvents()).toEqual([
    { type: 'media.stored', v: 1, mediaId: result.id, ownerId: principal.actorId, kind: 'upload' },
    { type: 'media.scanned', v: 1, mediaId: result.id, from: 'pending', to: 'clean' },
  ]);
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

describe('scanning behind the upload', () => {
  let stub: Awaited<ReturnType<typeof startArachnidStub>>;
  beforeAll(async () => {
    stub = await startArachnidStub();
  });
  afterAll(() => stub.close());
  const provider = (timeout = '600') => ({
    config: scanConfig({
      ARACHNID_USERNAME: stub.username,
      ARACHNID_PASSWORD: stub.password,
      ARACHNID_BASE_URL: stub.baseUrl,
      MEDIASCAN_TIMEOUT_MS: timeout,
    }),
  });

  test('a clean answer from the provider lets the upload stand', async () => {
    await seedSetting('uploads.enabled', true);
    stub.onMedia(() => ({ json: { classification: 'no-known-match' } }));
    const store = memoryStore();
    const result = await uploadImage(await uploader(), { bytes: bytes('png') }, { store, scan: provider() });
    expect(result.ok).toBe(true);
    expect((await mediaRows())[0]?.scanState).toBe('clean');
  });

  test('a match is media.rejected, the row is quarantined and the object stays for the evidence', async () => {
    await seedSetting('uploads.enabled', true);
    stub.onMedia(() => ({ json: { classification: 'csam', match_type: 'exact' } }));
    const store = memoryStore();
    expect(await uploadImage(await uploader(), { bytes: bytes('png') }, { store, scan: provider() })).toEqual({
      ok: false,
      reason: 'media.rejected',
    });
    const [row] = await mediaRows();
    expect(row?.scanState).toBe('quarantined');
    expect(store.objects.has(row!.storageKey!)).toBe(true);
  });

  test('an outage is media.scan_unavailable and the object is deleted at once', async () => {
    await seedSetting('uploads.enabled', true);
    stub.onMedia(() => ({ status: 500, json: {} }));
    const store = memoryStore();
    expect(await uploadImage(await uploader(), { bytes: bytes('png') }, { store, scan: provider() })).toEqual({
      ok: false,
      reason: 'media.scan_unavailable',
    });
    const [row] = await mediaRows();
    expect([row?.scanState, row?.storageKey, store.objects.size]).toEqual(['failed', null, 0]);
  });

  test('with no provider configured an enabled upload is refused, never accepted unscanned', async () => {
    await seedSetting('uploads.enabled', true);
    const store = memoryStore();
    expect(await uploadImage(await uploader(), { bytes: bytes('png') }, { store, scan: { config: scanConfig({}) } })).toEqual({
      ok: false,
      reason: 'media.scan_unavailable',
    });
    expect([(await mediaRows())[0]?.scanState, store.objects.size]).toEqual(['failed', 0]);
  });

  test('an identical copy of a listed image is quarantined with zero provider calls', async () => {
    await seedSetting('uploads.enabled', true);
    stub.requests.length = 0;
    const store = memoryStore();
    const principal = await uploader();
    const first = await uploadImage(principal, { bytes: bytes('gif') }, { store, scan: localScan });
    if (!first.ok) throw new Error(first.reason);
    await writer().insert(mediaBlocklist).values({ kind: 'sha256', value: first.sha256, category: 'spam' });
    expect(await uploadImage(principal, { bytes: bytes('gif') }, { store, scan: provider() })).toEqual({
      ok: false,
      reason: 'media.rejected',
    });
    expect(stub.requests).toEqual([]);
  });
});
