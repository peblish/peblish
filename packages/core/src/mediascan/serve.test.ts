import { beforeEach, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { memoryStore } from '../storage/memory.ts';
import { truncateAll } from '../testing/db.ts';
import { seedLocalInstance } from '../testing/seed-a.ts';
import { seedMedia } from '../testing/seed-safe.ts';
import { recordScan } from './record.ts';
import { findServable } from './serve.ts';
import { scanStates } from './state.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

const store = memoryStore();

test('only a clean, undeleted upload with its object is served; every other state is the same absence', async () => {
  for (const state of scanStates) {
    const row = await seedMedia(store, { state });
    const served = await findServable(row.id, { withBody: true, store });
    if (state === 'clean') expect(served).toMatchObject({ mimeType: 'image/png', sha256: row.sha256, byteSize: row.bytes.byteLength });
    else expect([state, served]).toEqual([state, null]);
  }
  const deleted = await seedMedia(store, { state: 'clean', deleted: true });
  const noObject = await seedMedia(store, { state: 'clean', stored: false });
  expect([await findServable(deleted.id, { withBody: true, store }), await findServable(noObject.id, { withBody: true, store })]).toEqual([
    null,
    null,
  ]);
  expect([
    await findServable('not-a-uuid', { withBody: true, store }),
    await findServable('0190a000-0000-7000-8000-000000000000', { withBody: true, store }),
  ]).toEqual([null, null]);
});

test('a head lookup reads no object', async () => {
  const row = await seedMedia(store, { state: 'clean' });
  expect(await findServable(row.id, { withBody: false, store: { ...store, get: () => Promise.reject(new Error('read')) } })).toMatchObject({
    body: null,
  });
});

test('one recordScan flips a served image to the absence an unknown id gets', async () => {
  const pending = await seedMedia(store, { state: 'pending' });
  expect(await findServable(pending.id, { withBody: true, store })).toBeNull();
  const principal = await systemPrincipal(db(), 'scheduled');
  const decision = await authorize('media.scan', principal, { mediaId: pending.id });
  if (!decision.ok) throw new Error(decision.reason);
  await recordScan(decision.grant, { outcome: { state: 'clean' }, now: new Date() });
  expect(await findServable(pending.id, { withBody: true, store })).not.toBeNull();
  // A clean image caught by a later list entry is quarantined (review.ts, addBlockedHash) and
  // stops being served: its state test is the one above.
});
