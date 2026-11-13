import { desc, eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { media } from '../db/tables/media.ts';
import { posts } from '../db/tables/content.ts';
import { modlog } from '../db/tables/moderation.ts';
import { deletionLedger } from '../db/tables/site.ts';
import { writer } from '../db/write.ts';
import { mediaEvidence, mediaEvidenceLog } from '../evidence/tables.ts';
import { purgePass } from '../evidence/purge.ts';
import { memoryStore } from '../storage/memory.ts';
import { truncateAll } from '../testing/db.ts';
import { seedLocalInstance } from '../testing/seed-a.ts';
import { admin, outboxEvents, seedAdmin, seedPost } from '../testing/seed-az.ts';
import { seedMedia, sha256Of } from '../testing/seed-safe.ts';
import { seedActor, localUser } from '../testing/seed.ts';
import { scanConfig } from './config.ts';
import type { ScanProvider } from './provider.ts';
import { addToBlocklist, removeFromBlocklist } from './list.ts';
import { confirmQuarantined, holdQuarantined, releaseQuarantined } from './review.ts';
import { findServable } from './serve.ts';
import { scanUpload } from './scan.ts';
import { mediaBlocklist, mediaScans } from './tables.ts';
import { mediaUrl } from './usage.ts';

const store = memoryStore();

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}
const local = { config: scanConfig({ MEDIASCAN_LOCAL_ONLY: '1' }), store };
const day = 86_400_000;

let instance: { id: string; domain: string; local: boolean; origin: string };
let adminId: string;
let uploaderId: string;
beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
  const row = await localInstance(db());
  instance = { ...row, domain: new URL(row.origin).host, local: true };
  adminId = (await seedAdmin(instance, 'reviewer')).id;
  uploaderId = (await seedActor(instance, 'Person', 'uploader')).id;
});

const asAdmin = () => admin(adminId);
const rowOf = async (id: string) => (await db().select().from(media).where(eq(media.id, id)))[0]!;
/** The image's current incident (its latest evidence row). */
const evidenceOf = async (id: string) =>
  (await db().select().from(mediaEvidence).where(eq(mediaEvidence.mediaId, id)).orderBy(desc(mediaEvidence.createdAt)).limit(1))[0]!;
const logOf = async (evidenceId: string) =>
  (await db().select().from(mediaEvidenceLog).where(eq(mediaEvidenceLog.evidenceId, evidenceId))).map((l) => l.event);

/** A real quarantine: an upload whose hash is on the list, scanned by the inline path. */
async function quarantined() {
  const row = await seedMedia(store, { ownerId: uploaderId });
  await writer().insert(mediaBlocklist).values({ kind: 'sha256', value: row.sha256!, category: 'csam' }).onConflictDoNothing();
  expect(await scanUpload(row.id, local)).toBe('quarantined');
  return row;
}

test('only a signed-in admin may review: a member, and an admin without two-factor (a session of role user), are refused', async () => {
  const row = await quarantined();
  const member = localUser(uploaderId);
  for (const attempt of [
    confirmQuarantined(member, { mediaId: row.id, removePosts: true }, { store }),
    releaseQuarantined(member, { mediaId: row.id }),
    holdQuarantined(member, { mediaId: row.id, authority: 'afp', reference: 'AFP-1', until: new Date(Date.now() + day) }),
    addToBlocklist(member, { value: 'a'.repeat(64), category: 'spam' }),
    removeFromBlocklist(member, row.id),
    confirmQuarantined({ kind: 'anonymous' }, { mediaId: row.id, removePosts: false }),
  ])
    expect(await attempt).toEqual({ ok: false, reason: expect.stringMatching(/^auth\.(admin_required|required)$/) });
  expect((await rowOf(row.id)).scanState).toBe('quarantined');
  expect(await confirmQuarantined(asAdmin(), { mediaId: '0190a000-0000-7000-8000-000000000000', removePosts: false })).toEqual({
    ok: false,
    reason: 'target.not_found',
  });
});

test('confirm blocks the image, lists its hash, writes the ledger and log, removes its posts, and leaves no bytes', async () => {
  const row = await quarantined();
  const community = await seedActor(instance, 'Group', 'pics');
  const author = await seedActor(instance, 'Person', 'poster');
  const using = await seedPost(instance, community, author, { url: mediaUrl(instance.origin, row.id) });
  const other = await seedPost(instance, community, author, { url: 'https://example.com/x.png' });
  const before = (await outboxEvents()).length;

  const result = await confirmQuarantined(
    asAdmin(),
    { mediaId: row.id, removePosts: true, note: 'confirmed by eye on the manifest' },
    { store },
  );
  expect(result).toEqual({ ok: true, removedPosts: 1, refusedPosts: 0 });

  expect(await rowOf(row.id)).toMatchObject({ scanState: 'blocked', storageKey: null });
  expect((await rowOf(row.id)).deletedAt).not.toBeNull();
  expect(store.objects.has(row.storageKey!)).toBe(false);
  expect(await findServable(row.id, { withBody: true, store })).toBeNull();
  const evidence = await evidenceOf(row.id);
  expect(evidence).toMatchObject({ status: 'confirmed', decidedBy: adminId, note: 'confirmed by eye on the manifest' });
  // Retention: the decision plus 24 months.
  expect(Math.round((evidence.retainUntil!.getTime() - evidence.decidedAt!.getTime()) / day)).toBeGreaterThanOrEqual(730);
  expect(await logOf(evidence.id)).toEqual(['quarantined', 'confirmed', 'purge_started']);
  expect((await db().select().from(mediaBlocklist).where(eq(mediaBlocklist.value, row.sha256!)))[0]).toMatchObject({ category: 'csam' });
  expect((await db().select().from(deletionLedger)).map((l) => [l.subjectKind, l.subjectId, l.reason, l.requestedBy])).toEqual([
    ['media', row.id, 'media.blocked', adminId],
  ]);
  expect([
    (await db().select().from(posts).where(eq(posts.id, using.id)))[0]?.removedAt === null,
    (await db().select().from(posts).where(eq(posts.id, other.id)))[0]?.removedAt === null,
  ]).toEqual([false, true]);
  // Private modlog rows only: the removal and the decision are not public.
  expect((await db().select().from(modlog).orderBy(modlog.id)).map((m) => [m.action, m.public])).toEqual([
    ['media.review', false],
    ['mod.remove', false],
  ]);
  // Listing the hash is announced, so the edge cache forgets any proxied copy (edge/takedowns.ts).
  expect((await outboxEvents()).slice(before).map((e) => (e as { type: string }).type)).toEqual([
    'media.hash_listed',
    'media.reviewed',
    'media.purged',
    'mod.remove',
  ]);
});

test('a second decision on the same image is refused', async () => {
  const row = await quarantined();
  expect((await confirmQuarantined(asAdmin(), { mediaId: row.id, removePosts: false }, { store })).ok).toBe(true);
  for (const second of [
    confirmQuarantined(asAdmin(), { mediaId: row.id, removePosts: false }),
    releaseQuarantined(asAdmin(), { mediaId: row.id }),
  ])
    expect(await second).toEqual({ ok: false, reason: 'media.not_quarantined' });
  const clean = await seedMedia(store, { state: 'clean' });
  const pending = await seedMedia(store, { state: 'pending' });
  for (const other of [clean, pending])
    expect(await confirmQuarantined(asAdmin(), { mediaId: other.id, removePosts: false })).toEqual({
      ok: false,
      reason: 'media.not_quarantined',
    });
});

test('confirming a block quarantines the clean copies of the same image, as adding its hash does', async () => {
  const bytes = Buffer.from('one image, uploaded three times');
  const earlier = await seedMedia(store, { state: 'clean', bytes, ownerId: uploaderId });
  const deleted = await seedMedia(store, { state: 'clean', bytes, deleted: true });
  const other = await seedMedia(store, { state: 'clean' });
  const caught = await seedMedia(store, { bytes, ownerId: uploaderId });
  const provider: ScanProvider = {
    name: 'stub',
    scan: async () => ({ result: 'match', classification: 'csam', matchType: 'exact', raw: {} }),
  };
  expect(await scanUpload(caught.id, { store, config: scanConfig({}), providers: [provider] })).toBe('quarantined');
  expect(await findServable(earlier.id, { withBody: false, store })).not.toBeNull();

  expect((await confirmQuarantined(asAdmin(), { mediaId: caught.id, removePosts: false }, { store })).ok).toBe(true);
  expect(await Promise.all([earlier, deleted, other].map(async (m) => (await rowOf(m.id)).scanState))).toEqual([
    'quarantined',
    'clean',
    'clean',
  ]);
  expect(await findServable(earlier.id, { withBody: false, store })).toBeNull();
  const [entry] = await db().select().from(mediaBlocklist).where(eq(mediaBlocklist.value, caught.sha256!));
  expect(await evidenceOf(earlier.id)).toMatchObject({ source: 'list', classification: 'csam', status: 'open' });
  expect(((await evidenceOf(earlier.id)).manifest as { verdict: unknown }).verdict).toMatchObject({ source: 'list', entryId: entry!.id });
});

test('release returns a false positive to clean and it is served again', async () => {
  const row = await quarantined();
  expect(await findServable(row.id, { withBody: true, store })).toBeNull();
  expect(await releaseQuarantined(asAdmin(), { mediaId: row.id, note: 'a holiday photo' })).toMatchObject({ ok: true });
  expect((await rowOf(row.id)).scanState).toBe('clean');
  expect(await findServable(row.id, { withBody: true, store })).not.toBeNull();
  expect(await evidenceOf(row.id)).toMatchObject({ status: 'released', decidedBy: adminId, note: 'a holiday photo' });
  expect(await logOf((await evidenceOf(row.id)).id)).toEqual(['quarantined', 'released']);
});

test('a hold keeps the bytes through confirmation and the undecided expiry, and ends with its date', async () => {
  const now = new Date();
  const held = await quarantined();
  const plain = await quarantined();
  // Refusals: no reference, a date in the past.
  for (const bad of [
    { reference: '  ', until: new Date(now.getTime() + day) },
    { reference: 'AFP-9', until: new Date(now.getTime() - day) },
  ])
    expect(await holdQuarantined(asAdmin(), { mediaId: held.id, authority: 'afp', ...bad })).toEqual({
      ok: false,
      reason: 'media.hold_invalid',
    });
  const until = new Date(now.getTime() + 365 * day);
  expect(await holdQuarantined(asAdmin(), { mediaId: held.id, authority: 'afp', reference: 'AFP-2026-114', until })).toMatchObject({
    ok: true,
  });
  expect(await evidenceOf(held.id)).toMatchObject({ holdReference: 'AFP-2026-114', holdUntil: until });

  // Eight days on, the undecided window (7 days) has ended for both; only the held one is spared.
  const eightDays = new Date(now.getTime() + 8 * day);
  const run = await purgePass({ store, now: eightDays, days: 7 });
  expect(run).toMatchObject({ expired: 1, purged: 1 });
  expect((await rowOf(held.id)).scanState).toBe('quarantined');
  expect(store.objects.has(held.storageKey!)).toBe(true);
  expect([(await rowOf(plain.id)).scanState, (await rowOf(plain.id)).storageKey]).toEqual(['blocked', null]);

  // An admin confirms the held one: blocked, but the bytes stay while the hold stands.
  expect((await confirmQuarantined(asAdmin(), { mediaId: held.id, removePosts: false }, { store, now: eightDays })).ok).toBe(true);
  await purgePass({ store, now: eightDays, days: 7 });
  expect([(await rowOf(held.id)).scanState, store.objects.has(held.storageKey!)]).toEqual(['blocked', true]);
  // The manifest outlives the 24 months by the hold, and a purge after the date takes the bytes.
  expect((await evidenceOf(held.id)).retainUntil!.getTime()).toBeGreaterThanOrEqual(until.getTime());
  await purgePass({ store, now: new Date(until.getTime() + day), days: 7 });
  expect([(await rowOf(held.id)).storageKey, store.objects.has(held.storageKey!)]).toEqual([null, false]);
});

test('a hold cannot land between the purge claiming the bytes and its bucket delete', async () => {
  const row = await quarantined();
  const deleting = gate();
  const finish = gate();
  const slow = {
    ...store,
    async delete(key: string) {
      deleting.open();
      await finish.opened;
      await store.delete(key);
    },
  };
  const confirming = confirmQuarantined(asAdmin(), { mediaId: row.id, removePosts: false }, { store: slow });
  await deleting.opened;
  // The purge has claimed the bytes and its bucket delete is in flight: a hold now is too late.
  expect(
    await holdQuarantined(asAdmin(), {
      mediaId: row.id,
      authority: 'afp',
      reference: 'AFP-2026-7',
      until: new Date(Date.now() + 30 * day),
    }),
  ).toEqual({
    ok: false,
    reason: 'media.already_decided',
  });
  finish.open();
  expect((await confirming).ok).toBe(true);
  const evidence = await evidenceOf(row.id);
  expect(evidence).toMatchObject({ holdReference: null, holdUntil: null });
  expect(evidence.purgeStartedAt).not.toBeNull();
  expect(await logOf(evidence.id)).toEqual(['quarantined', 'confirmed', 'purge_started']);
  expect([(await rowOf(row.id)).storageKey, store.objects.has(row.storageKey!)]).toEqual([null, false]);
});

test('only an AFP direction keeps the image bytes: NCMEC and NCA holds keep the record, and the bytes follow the normal purge', async () => {
  const now = new Date();
  const until = new Date(now.getTime() + 365 * day);
  const afp = await quarantined();
  const ncmec = await quarantined();
  const nca = await quarantined();
  for (const [row, authority, reference] of [
    [afp, 'afp', 'AFP-2026-114'],
    [ncmec, 'ncmec', 'CT-1234567'],
    [nca, 'nca', 'NCA-77'],
  ] as const)
    expect(await holdQuarantined(asAdmin(), { mediaId: row.id, authority, reference, until })).toMatchObject({ ok: true });
  expect(await evidenceOf(ncmec.id)).toMatchObject({ holdAuthority: 'ncmec', holdReference: 'CT-1234567', holdUntil: until });
  const [line] = await db().select().from(mediaEvidenceLog).where(eq(mediaEvidenceLog.event, 'hold')).orderBy(mediaEvidenceLog.id);
  expect(line?.note).toBe(`AFP AFP-2026-114 until ${until.toISOString()}`);

  // Eight days on the undecided window has ended: the AFP hold stops the automatic block; the others are blocked and purged.
  const eightDays = new Date(now.getTime() + 8 * day);
  expect(await purgePass({ store, now: eightDays, days: 7 })).toMatchObject({ expired: 2, purged: 2 });
  expect([(await rowOf(afp.id)).scanState, store.objects.has(afp.storageKey!)]).toEqual(['quarantined', true]);
  for (const row of [ncmec, nca]) {
    expect([(await rowOf(row.id)).scanState, (await rowOf(row.id)).storageKey, store.objects.has(row.storageKey!)]).toEqual([
      'blocked',
      null,
      false,
    ]);
    // The record stays: manifest, hashes and log, kept at least until the hold's date.
    const evidence = await evidenceOf(row.id);
    expect(evidence.holdUntil).toEqual(until);
    expect(evidence.retainUntil!.getTime()).toBeGreaterThanOrEqual(until.getTime());
    expect(await logOf(evidence.id)).toEqual(['quarantined', 'hold', 'expired', 'purge_started']);
  }
  // Confirmed, the AFP-held image keeps its bytes while the hold stands.
  expect((await confirmQuarantined(asAdmin(), { mediaId: afp.id, removePosts: false }, { store, now: eightDays })).ok).toBe(true);
  expect(store.objects.has(afp.storageKey!)).toBe(true);
});

test('a hold cannot narrow: while an AFP hold is in force, only another AFP hold replaces it', async () => {
  const now = new Date();
  const until = new Date(now.getTime() + 365 * day);
  const row = await quarantined();
  expect(await holdQuarantined(asAdmin(), { mediaId: row.id, authority: 'afp', reference: 'AFP-1', until }, { now })).toMatchObject({
    ok: true,
  });
  for (const authority of ['ncmec', 'nca'] as const)
    expect(await holdQuarantined(asAdmin(), { mediaId: row.id, authority, reference: 'X-1', until }, { now })).toEqual({
      ok: false,
      reason: 'media.hold_invalid',
    });
  expect(await holdQuarantined(asAdmin(), { mediaId: row.id, authority: 'afp', reference: 'AFP-2', until }, { now })).toMatchObject({
    ok: true,
  });
  expect(await evidenceOf(row.id)).toMatchObject({ holdAuthority: 'afp', holdReference: 'AFP-2' });
  // Once the AFP direction has ended, another authority may hold the record.
  const later = new Date(until.getTime() + day);
  expect(
    await holdQuarantined(
      asAdmin(),
      { mediaId: row.id, authority: 'ncmec', reference: 'CT-1', until: new Date(later.getTime() + day) },
      { now: later },
    ),
  ).toMatchObject({ ok: true });
});

test('a hold on a released image, or on bytes already purged, is refused as already decided', async () => {
  const until = new Date(Date.now() + 30 * day);
  const released = await quarantined();
  await releaseQuarantined(asAdmin(), { mediaId: released.id });
  expect(await holdQuarantined(asAdmin(), { mediaId: released.id, authority: 'afp', reference: 'R', until })).toEqual({
    ok: false,
    reason: 'media.not_quarantined',
  });
  const purged = await quarantined();
  await confirmQuarantined(asAdmin(), { mediaId: purged.id, removePosts: false }, { store });
  expect(await holdQuarantined(asAdmin(), { mediaId: purged.id, authority: 'afp', reference: 'R', until })).toEqual({
    ok: false,
    reason: 'media.already_decided',
  });
  const clean = await seedMedia(store, { state: 'clean' });
  expect(await holdQuarantined(asAdmin(), { mediaId: clean.id, authority: 'afp', reference: 'R', until })).toEqual({
    ok: false,
    reason: 'media.not_quarantined',
  });
});

test('an undecided quarantine ends after the window with no admin named, and not before', async () => {
  const row = await quarantined();
  const now = new Date();
  await purgePass({ store, now: new Date(now.getTime() + 6 * day), days: 7 });
  expect((await rowOf(row.id)).scanState).toBe('quarantined');
  await purgePass({ store, now: new Date(now.getTime() + 8 * day), days: 7 });
  expect([(await rowOf(row.id)).scanState, (await rowOf(row.id)).storageKey]).toEqual(['blocked', null]);
  expect(await evidenceOf(row.id)).toMatchObject({ status: 'confirmed', decidedBy: null });
  expect(await logOf((await evidenceOf(row.id)).id)).toEqual(['quarantined', 'expired', 'purge_started']);
  expect((await db().select().from(deletionLedger)).map((l) => [l.subjectId, l.requestedBy])).toEqual([[row.id, null]]);
  expect((await outboxEvents()).map((e) => (e as { type: string }).type)).toEqual([
    'media.quarantined',
    'media.hash_listed',
    'media.scanned',
    'media.purged',
  ]);
});

test('manifests are deleted after their retention, a hold postpones that, and the log keeps a line', async () => {
  const row = await quarantined();
  await confirmQuarantined(asAdmin(), { mediaId: row.id, removePosts: false }, { store });
  const evidence = await evidenceOf(row.id);
  const justBefore = new Date(evidence.retainUntil!.getTime() - day);
  expect((await purgePass({ store, now: justBefore, days: 7 })).manifests).toBe(0);
  const after = new Date(evidence.retainUntil!.getTime() + day);
  expect((await purgePass({ store, now: after, days: 7 })).manifests).toBe(1);
  expect(await db().select().from(mediaEvidence)).toEqual([]);
  expect((await db().select().from(mediaEvidenceLog).where(eq(mediaEvidenceLog.evidenceId, evidence.id))).map((l) => l.event)).toEqual([
    'quarantined',
    'confirmed',
    'purge_started',
    'manifest_expired',
  ]);
});

test('failed images lose their bytes in the purge pass', async () => {
  const failed = await seedMedia(store, { state: 'failed' });
  expect((await purgePass({ store })).purged).toBe(1);
  expect([(await rowOf(failed.id)).storageKey, store.objects.has(failed.storageKey!)]).toEqual([null, false]);
  expect((await outboxEvents()).at(-1)).toEqual({ type: 'media.purged', v: 1, mediaId: failed.id, cause: 'failed' });
});

test('held images and failing deletions cannot fill the purge batch', async () => {
  const until = new Date(Date.now() + 365 * day);
  // First in line: two confirmed images whose bytes a hold keeps.
  for (const reference of ['AFP-1', 'AFP-2']) {
    const held = await quarantined();
    expect(await holdQuarantined(asAdmin(), { mediaId: held.id, authority: 'afp', reference, until })).toMatchObject({ ok: true });
    expect((await confirmQuarantined(asAdmin(), { mediaId: held.id, removePosts: false }, { store })).ok).toBe(true);
  }
  // Then two failed images whose deletes keep failing, and one whose delete works.
  const stuck = [await seedMedia(store, { state: 'failed' }), await seedMedia(store, { state: 'failed' })];
  const fine = await seedMedia(store, { state: 'failed' });
  const flaky = {
    ...store,
    async delete(key: string) {
      if (stuck.some((row) => row.storageKey === key)) throw new Error('AccessDenied');
      await store.delete(key);
    },
  };
  const now = new Date();
  // The held images are not candidates at all; the two stuck deletions take the batch once and back off.
  expect((await purgePass({ store: flaky, now, batch: 2 })).purged).toBe(0);
  expect((await purgePass({ store: flaky, now, batch: 2 })).purged).toBe(1);
  expect((await rowOf(fine.id)).storageKey).toBeNull();
  for (const row of stuck) {
    const [scan] = await db().select().from(mediaScans).where(eq(mediaScans.mediaId, row.id));
    expect(scan?.purgeAttempts).toBe(1);
    expect(scan!.purgeRetryAt!.getTime()).toBeGreaterThan(now.getTime());
  }
  // After the back-off they are tried again.
  expect((await purgePass({ store, now: new Date(now.getTime() + 3_600_000), batch: 2 })).purged).toBe(2);
});

test('adding a hash quarantines the clean copies, each with evidence; bad and repeated hashes are refused; removal leaves decided images alone', async () => {
  const a = await seedMedia(store, { state: 'clean', bytes: Buffer.from('same'), ownerId: uploaderId });
  const b = await seedMedia(store, { state: 'clean', bytes: Buffer.from('same'), ownerId: uploaderId });
  const pending = await seedMedia(store, { state: 'pending', bytes: Buffer.from('same') });
  const deleted = await seedMedia(store, { state: 'clean', bytes: Buffer.from('same'), deleted: true });
  const different = await seedMedia(store, { state: 'clean', bytes: Buffer.from('other') });
  const value = sha256Of(Buffer.from('same'));

  for (const bad of ['', 'xyz', 'a'.repeat(63), 'g'.repeat(64)])
    expect(await addToBlocklist(asAdmin(), { value: bad, category: 'spam' })).toEqual({ ok: false, reason: 'media.hash_invalid' });
  const added = await addToBlocklist(asAdmin(), { value: value.toUpperCase(), category: 'violent', reason: 'a known shock image' });
  expect(added).toMatchObject({ ok: true, quarantined: 2 });
  expect(await addToBlocklist(asAdmin(), { value, category: 'spam' })).toEqual({ ok: false, reason: 'media.hash_exists' });
  expect((await db().select().from(mediaBlocklist))[0]).toMatchObject({
    value,
    category: 'violent',
    reason: 'a known shock image',
    addedBy: adminId,
  });

  expect([a, b, pending, deleted, different].map((m) => m.id)).toHaveLength(5);
  expect(await Promise.all([a, b, pending, deleted, different].map(async (m) => (await rowOf(m.id)).scanState))).toEqual([
    'quarantined',
    'quarantined',
    'pending',
    'clean',
    'clean',
  ]);
  expect((await db().select().from(mediaEvidence)).map((e) => [e.source, e.classification])).toEqual([
    ['list', 'violent'],
    ['list', 'violent'],
  ]);
  expect(await findServable(a.id, { withBody: true, store })).toBeNull();
  // The pending copy meets the list when it is scanned.
  expect(await scanUpload(pending.id, local)).toBe('quarantined');

  if (!added.ok) throw new Error('unreachable');
  expect(await removeFromBlocklist(asAdmin(), added.entryId)).toMatchObject({ ok: true });
  expect(await removeFromBlocklist(asAdmin(), added.entryId)).toEqual({ ok: false, reason: 'target.not_found' });
  expect(await db().select().from(mediaBlocklist)).toEqual([]);
  expect((await rowOf(a.id)).scanState).toBe('quarantined');
});

test('adding and removing a hash by hand each write a deletion_ledger row naming the hash, for a restore to replay (TN8)', async () => {
  const value = sha256Of(Buffer.from('listed by hand'));
  const added = await addToBlocklist(asAdmin(), { value, category: 'violent', reason: 'a known shock image' });
  if (!added.ok) throw new Error('not added');
  expect(await removeFromBlocklist(asAdmin(), added.entryId)).toMatchObject({ ok: true });
  // A refused change writes nothing.
  expect(await removeFromBlocklist(asAdmin(), added.entryId)).toEqual({ ok: false, reason: 'target.not_found' });
  expect(await addToBlocklist(asAdmin(), { value: 'xyz', category: 'spam' })).toMatchObject({ ok: false });
  const rows = await db().select().from(deletionLedger).orderBy(deletionLedger.id);
  expect(
    rows.map(({ subjectKind, subjectId, reason, requestedBy, details }) => ({ subjectKind, subjectId, reason, requestedBy, details })),
  ).toEqual([
    {
      subjectKind: 'media',
      subjectId: added.entryId,
      reason: 'media.hash_added',
      requestedBy: adminId,
      details: { sha256: value, category: 'violent', reason: 'a known shock image' },
    },
    { subjectKind: 'media', subjectId: added.entryId, reason: 'media.hash_removed', requestedBy: adminId, details: { sha256: value } },
  ]);
});

test('a requarantine opens a new incident: the earlier one keeps its record, and the new one starts its own clock', async () => {
  const start = new Date();
  const at = (days: number) => new Date(start.getTime() + days * day);
  const row = await seedMedia(store, { ownerId: uploaderId });
  await writer().insert(mediaBlocklist).values({ kind: 'sha256', value: row.sha256!, category: 'csam' });
  expect(await scanUpload(row.id, { ...local, now: () => start })).toBe('quarantined');
  await releaseQuarantined(asAdmin(), { mediaId: row.id, note: 'a holiday photo' }, { now: at(1) });
  const [first] = await db().select().from(mediaEvidence).where(eq(mediaEvidence.mediaId, row.id));
  const [entry] = await db().select().from(mediaBlocklist);
  await removeFromBlocklist(asAdmin(), entry!.id);

  // A month later the hash is listed again and catches the released image.
  expect(await addToBlocklist(asAdmin(), { value: row.sha256!, category: 'other' }, at(30))).toMatchObject({ ok: true, quarantined: 1 });
  const incidents = await db().select().from(mediaEvidence).where(eq(mediaEvidence.mediaId, row.id)).orderBy(mediaEvidence.createdAt);
  expect(incidents).toHaveLength(2);
  expect(incidents[0]).toEqual(first);
  expect(incidents[0]).toMatchObject({ status: 'released', note: 'a holiday photo', classification: 'csam' });
  expect(incidents[1]).toMatchObject({ status: 'open', classification: 'other', decidedBy: null, retainUntil: null, createdAt: at(30) });
  expect(incidents[1]!.manifestSha256).not.toBe(first!.manifestSha256);
  expect([await logOf(incidents[0]!.id), await logOf(incidents[1]!.id)]).toEqual([['quarantined', 'released'], ['requarantined']]);

  // The undecided window runs from the requarantine, not the first quarantine.
  expect((await purgePass({ store, now: at(36), days: 7 })).expired).toBe(0);
  expect((await rowOf(row.id)).scanState).toBe('quarantined');
  expect((await purgePass({ store, now: at(38), days: 7 })).expired).toBe(1);
  expect((await rowOf(row.id)).scanState).toBe('blocked');
  expect((await db().select().from(mediaEvidence).where(eq(mediaEvidence.id, incidents[0]!.id)))[0]).toEqual(first);
});
