import { beforeEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { writer } from '../db/write.ts';
import { purgePass } from '../evidence/purge.ts';
import { memoryStore } from '../storage/memory.ts';
import { truncateAll } from '../testing/db.ts';
import { seedLocalInstance } from '../testing/seed-a.ts';
import { admin, seedAdmin } from '../testing/seed-az.ts';
import { seedMedia } from '../testing/seed-safe.ts';
import { seedActor } from '../testing/seed.ts';
import { scanConfig } from './config.ts';
import { addToBlocklist, removeFromBlocklist } from './list.ts';
import { mediaOverview } from './overview.ts';
import { confirmQuarantined, holdQuarantined, releaseQuarantined } from './review.ts';
import { scanUpload } from './scan.ts';
import { mediaBlocklist } from './tables.ts';

const store = memoryStore();
const day = 86_400_000;

let adminId: string;
let uploaderId: string;
beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
  const row = await localInstance(db());
  const instance = { ...row, domain: new URL(row.origin).host, local: true };
  adminId = (await seedAdmin(instance, 'reviewer')).id;
  uploaderId = (await seedActor(instance, 'Person', 'uploader')).id;
});

/** The evidence table's byte status of each incident of the image, oldest first. */
const bytesOf = async (mediaId: string, now = new Date()) =>
  (await mediaOverview(now)).evidence
    .filter((row) => row.mediaId === mediaId)
    .reverse()
    .map((row) => [row.status, row.bytes]);

test('every incident of an image shows what is stored now: a released one says kept only while the image is clean', async () => {
  const row = await seedMedia(store, { ownerId: uploaderId });
  await writer().insert(mediaBlocklist).values({ kind: 'sha256', value: row.sha256!, category: 'csam' });
  expect(await scanUpload(row.id, { config: scanConfig({ MEDIASCAN_LOCAL_ONLY: '1' }), store })).toBe('quarantined');
  await releaseQuarantined(admin(adminId), { mediaId: row.id });
  expect(await bytesOf(row.id)).toEqual([['released', 'kept']]);

  // The hash is listed again and catches the image: a new incident, undecided.
  const [entry] = await db().select().from(mediaBlocklist);
  await removeFromBlocklist(admin(adminId), entry!.id);
  expect(await addToBlocklist(admin(adminId), { value: row.sha256!, category: 'other' })).toMatchObject({ ok: true, quarantined: 1 });
  expect(await bytesOf(row.id)).toEqual([['released', 'waiting']]);

  // An AFP hold on the new incident keeps the one stored object, through the confirmation.
  const until = new Date(Date.now() + day);
  expect(await holdQuarantined(admin(adminId), { mediaId: row.id, authority: 'afp', reference: 'AFP-1', until })).toMatchObject({
    ok: true,
  });
  expect(await confirmQuarantined(admin(adminId), { mediaId: row.id, removePosts: false }, { store })).toMatchObject({ ok: true });
  expect(await bytesOf(row.id)).toEqual([
    ['released', 'held'],
    ['confirmed', 'held'],
  ]);

  // Once the hold ends the purge takes the bytes, and the released incident says so too.
  const later = new Date(until.getTime() + day);
  await purgePass({ store, now: later });
  expect(await bytesOf(row.id, later)).toEqual([
    ['released', 'purged'],
    ['confirmed', 'purged'],
  ]);
});
