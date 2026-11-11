import { db } from '@peblish/core/db/read';
import { localInstance } from '@peblish/core/db/local-instance';
import { deletionLedger } from '@peblish/core/db/tables/site';
import { writer } from '@peblish/core/db/write';
import { lockHash } from '@peblish/core/mediascan/hash-lock';
import { addToBlocklist, removeFromBlocklist } from '@peblish/core/mediascan/list';
import { confirmQuarantined } from '@peblish/core/mediascan/review';
import { mediaBlocklist } from '@peblish/core/mediascan/tables';
import { memoryStore } from '@peblish/core/storage/memory';
import { truncateAll } from '@peblish/core/testing/db';
import { seedLocalInstance } from '@peblish/core/testing/seed-a';
import { admin, gate, seedAdmin } from '@peblish/core/testing/seed-az';
import { seedMedia } from '@peblish/core/testing/seed-safe';
import { seedActor } from '@peblish/core/testing/seed';
import { asc, sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { reapplyLedger } from './drill.ts';

// A media block and an admin's removal of the same hash, forced to interleave on two connections
// while a third holds the hash lock (mediascan/hash-lock.ts). Whatever order they commit in, the
// ledger must replay to the list as it is, or a restore lists or unlists the hash wrongly.

/** Backends waiting for the hash lock of `sha256`; a bigint advisory key is split across classid and objid. */
async function waitersOn(sha256: string): Promise<number> {
  const [row] = await db().execute<{ n: number }>(sql`
    with k as (select hashtextextended(${`peblish.media_sha256:${sha256}`}, 0) as key)
    select count(*)::int as n from pg_locks, k
    where locktype = 'advisory' and not granted and objsubid = 1
      and database = (select oid from pg_database where datname = current_database())
      and classid::bigint = (k.key >> 32) & 4294967295 and objid::bigint = k.key & 4294967295`);
  return row?.n ?? 0;
}

const listed = async () => (await db().select({ value: mediaBlocklist.value }).from(mediaBlocklist)).map((entry) => entry.value);

test('a block and a removal of one hash, interleaved, leave a ledger that replays to the list as it is', { timeout: 60_000 }, async () => {
  await truncateAll();
  await seedLocalInstance();
  const row = await localInstance(db());
  const instance = { ...row, domain: new URL(row.origin).host, local: true };
  const adminId = (await seedAdmin(instance, 'reviewer')).id;
  const uploaderId = (await seedActor(instance, 'Person', 'uploader')).id;
  const store = memoryStore();
  // A listed hash whose one copy the listing quarantined: an admin can confirm the copy or take the hash off.
  const image = await seedMedia(store, { ownerId: uploaderId, bytes: Buffer.from('confirmed while unlisted'), state: 'clean' });
  const sha256 = image.sha256!;
  const added = await addToBlocklist(admin(adminId), { value: sha256, category: 'spam' });
  if (!added.ok) throw new Error('not listed');
  expect(added.quarantined).toBe(1);

  // A third connection holds the hash lock, so each write stops at it.
  const held = gate();
  const release = gate();
  const holder = writer().transaction(async (w) => {
    await lockHash(w, sha256);
    held.open();
    await release.opened;
  });
  await held.opened;

  // The block starts and waits for the lock.
  const blocking = confirmQuarantined(admin(adminId), { mediaId: image.id, removePosts: false }, { store });
  await expect.poll(() => waitersOn(sha256)).toBe(1);
  // The removal: it either waits for the lock too, or (without it) commits while the block waits.
  let removalSettled = false;
  const removing = removeFromBlocklist(admin(adminId), added.entryId).finally(() => (removalSettled = true));
  await expect.poll(async () => removalSettled || (await waitersOn(sha256)) === 2).toBe(true);
  release.open();
  await holder;
  expect(await blocking).toMatchObject({ ok: true });
  expect(await removing).toEqual({ ok: true });

  // Replayed over the database that wrote it, the ledger changes nothing on the list.
  const live = await listed();
  await reapplyLedger(process.env.DATABASE_URL ?? '', []);
  expect(await listed()).toEqual(live);
  // The block waited first, so it went first: it kept the entry, then the removal took it off.
  const ledger = await db().select({ reason: deletionLedger.reason }).from(deletionLedger).orderBy(asc(deletionLedger.id));
  expect(ledger.map((entry) => entry.reason)).toEqual(['media.hash_added', 'media.blocked', 'media.hash_removed']);
  expect(live).toEqual([]);
});
