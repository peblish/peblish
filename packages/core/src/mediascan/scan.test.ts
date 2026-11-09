import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { writer } from '../db/write.ts';
import { manifestDigest, type Manifest } from '../evidence/manifest.ts';
import { mediaEvidence, mediaEvidenceLog } from '../evidence/tables.ts';
import { memoryStore } from '../storage/memory.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance } from '../testing/seed-a.ts';
import { outboxEvents } from '../testing/seed-az.ts';
import { seedMedia, sha256Of, startArachnidStub, type ArachnidStub } from '../testing/seed-safe.ts';
import { arachnidProvider } from './arachnid.ts';
import { scanConfig } from './config.ts';
import { claimScan, recordScan, type ScanOutcome } from './record.ts';
import { scanClaimed, type ScanDeps } from './scan.ts';
import { mediaBlocklist, mediaScans } from './tables.ts';
import { scanStates } from './state.ts';

let stub: ArachnidStub;
beforeAll(async () => {
  stub = await startArachnidStub();
});
afterAll(() => stub.close());
let uploader: string;
beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
  uploader = (await seedAccount('uploader')).actorId;
  stub.requests.length = 0;
  stub.onMedia(() => ({ json: { classification: 'no-known-match' } }));
});

const store = memoryStore();
const config = (extra: Record<string, string> = {}) =>
  scanConfig({
    ARACHNID_USERNAME: stub.username,
    ARACHNID_PASSWORD: stub.password,
    ARACHNID_BASE_URL: stub.baseUrl,
    MEDIASCAN_TIMEOUT_MS: '600',
    ...extra,
  });
const providerDeps = (extra: Record<string, string> = {}): ScanDeps => ({ store, config: config(extra) });

const rowOf = async (id: string) => (await db().select().from(media).where(eq(media.id, id)))[0]!;

/** The inline path: claim the one row, scan it, record the outcome (final: no retry). */
async function scanNow(id: string, deps: ScanDeps) {
  const principal = await systemPrincipal(db(), 'scheduled');
  const decision = await authorize('media.scan_claim', principal, { mediaId: id });
  if (!decision.ok) throw new Error(decision.reason);
  const [claim] = await claimScan(decision.grant, { now: new Date() });
  if (!claim) throw new Error('not claimed');
  return scanClaimed(claim, { ...deps, final: true });
}

/** Claims the row (a row that is not pending cannot be claimed: any token then) and records `outcome` under that claim. */
async function record(id: string, outcome: ScanOutcome) {
  const principal = await systemPrincipal(db(), 'scheduled');
  const claiming = await authorize('media.scan_claim', principal, { mediaId: id });
  const decision = await authorize('media.scan', principal, { mediaId: id });
  if (!claiming.ok || !decision.ok) throw new Error('refused');
  const [claim] = await claimScan(claiming.grant, { now: new Date() });
  return recordScan(decision.grant, { outcome, now: new Date(), token: claim?.token ?? randomUUID() });
}

test('a pending row with no match becomes clean, and the provider saw exactly the stored bytes', async () => {
  const row = await seedMedia(store, { ownerId: uploader });
  expect(await scanNow(row.id, providerDeps())).toBe('clean');
  expect((await rowOf(row.id)).scanState).toBe('clean');
  expect((await rowOf(row.id)).scannedAt).not.toBeNull();
  expect(stub.requests.map((r) => [r.method, r.path, r.body.equals(Buffer.from(row.bytes))])).toEqual([['POST', '/v1/media', true]]);
  expect(await outboxEvents()).toEqual([{ type: 'media.scanned', v: 1, mediaId: row.id, from: 'pending', to: 'clean' }]);
});

test('a list match quarantines with zero provider calls, writing evidence, manifest and log together', async () => {
  const row = await seedMedia(store, { ownerId: uploader });
  const [entry] = await writer()
    .insert(mediaBlocklist)
    .values({ kind: 'sha256', value: row.sha256!, category: 'spam', reason: 'seen before' })
    .returning();
  expect(await scanNow(row.id, providerDeps())).toBe('quarantined');
  expect(stub.requests).toEqual([]);
  expect((await rowOf(row.id)).scanState).toBe('quarantined');
  const [evidence] = await db().select().from(mediaEvidence);
  expect(evidence).toMatchObject({
    mediaId: row.id,
    source: 'list',
    classification: 'spam',
    matchType: 'exact',
    status: 'open',
    decidedBy: null,
    retainUntil: null,
  });
  const manifest = evidence!.manifest as Manifest;
  expect(manifest).toMatchObject({
    v: 1,
    mediaId: row.id,
    sha256: row.sha256,
    mimeType: 'image/png',
    byteSize: row.bytes.byteLength,
    storageKey: row.storageKey,
    uploader: { actorId: uploader },
    verdict: { source: 'list', entryId: entry!.id, category: 'spam' },
    posts: [],
    pendingDeliveries: [],
  });
  expect(evidence!.manifestSha256).toBe(manifestDigest(manifest));
  // No request address anywhere in what is kept.
  expect(JSON.stringify(manifest)).not.toMatch(/\bip\b|address/i);
  expect((await db().select().from(mediaEvidenceLog)).map((l) => [l.evidenceId, l.actorId, l.event])).toEqual([
    [evidence!.id, null, 'quarantined'],
  ]);
  expect(await outboxEvents()).toEqual([
    { type: 'media.quarantined', v: 1, mediaId: row.id, evidenceId: evidence!.id, source: 'list', classification: 'spam', from: 'pending' },
  ]);
  // The one object stays where it was, and nothing else was stored.
  expect([...store.objects.keys()]).toContain(row.storageKey);
});

test('a provider match quarantines with its classification, match type, raw answer and list version', async () => {
  const row = await seedMedia(store, { ownerId: uploader });
  stub.onMedia(() => ({ json: { classification: 'csam', match_type: 'near', score: 0.91 } }));
  expect(await scanNow(row.id, providerDeps())).toBe('quarantined');
  const [evidence] = await db().select().from(mediaEvidence);
  expect(evidence).toMatchObject({ source: 'provider', classification: 'csam', matchType: 'near' });
  expect((evidence!.manifest as Manifest).verdict).toEqual({
    source: 'provider',
    provider: 'arachnid',
    classification: 'csam',
    matchType: 'near',
    raw: { classification: 'csam', match_type: 'near', score: 0.91 },
    listVersion: '{"version":"stub-list-1"}',
  });
  // The credential is in no stored place.
  const everything = JSON.stringify([evidence, await db().select().from(mediaEvidenceLog)]);
  expect(everything).not.toContain(stub.password);
});

test('no provider, a timeout, 401, 500 and a malformed answer all fail closed, with no credential in the error', async () => {
  const cases: [string, ScanDeps, () => void][] = [
    ['no provider', { store, config: scanConfig({}) }, () => undefined],
    [
      'local-only is the one way to run without a provider and is clean',
      { store, config: scanConfig({ MEDIASCAN_LOCAL_ONLY: '1' }) },
      () => undefined,
    ],
    [
      'timeout',
      providerDeps({ MEDIASCAN_TIMEOUT_MS: '50' }),
      () => stub.onMedia(() => ({ delayMs: 400, json: { classification: 'no-known-match' } })),
    ],
    ['500', providerDeps(), () => stub.onMedia(() => ({ status: 500, json: {} }))],
    [
      'wrong password',
      {
        store,
        config: config(),
        providers: [arachnidProvider({ baseUrl: stub.baseUrl, username: stub.username, password: 'wrong-secret-pw' })],
      },
      () => undefined,
    ],
    ['not JSON', providerDeps(), () => stub.onMedia(() => ({ text: '<html>oops' }))],
    ['unknown classification', providerDeps(), () => stub.onMedia(() => ({ json: { classification: 'maybe' } }))],
    ['empty object', providerDeps(), () => stub.onMedia(() => ({ json: {} }))],
  ];
  for (const [label, deps, arrange] of cases) {
    stub.onMedia(() => ({ json: { classification: 'no-known-match' } }));
    arrange();
    const row = await seedMedia(store, { ownerId: uploader });
    const state = await scanNow(row.id, deps);
    const expected = label.startsWith('local-only') ? 'clean' : 'failed';
    expect([label, state]).toEqual([label, expected]);
    expect([label, (await rowOf(row.id)).scanState]).toEqual([label, expected]);
    const lastError = (await db().select().from(mediaScans).where(eq(mediaScans.mediaId, row.id)))[0]?.lastError ?? '';
    expect(lastError).not.toMatch(/secret|password|wrong-secret-pw|Basic /i);
  }
});

test('every state change other than pending to clean, quarantined or failed is refused by recordScan', async () => {
  const { id } = await seedMedia(store, { ownerId: uploader });
  await record(id, { state: 'clean' });
  for (const state of scanStates) {
    const row = await seedMedia(store, { ownerId: null, state });
    for (const outcome of [{ state: 'clean' }, { state: 'failed', error: 'x' }] as const) {
      if (state === 'pending') continue;
      await expect(record(row.id, outcome), `${state} to ${outcome.state}`).rejects.toMatchObject({ reason: 'media.not_pending' });
    }
    if (state !== 'pending')
      await expect(
        record(row.id, {
          state: 'quarantined',
          verdict: { source: 'list', entryId: id, category: 'spam', listedAt: new Date().toISOString() },
        }),
        `${state} to quarantined`,
      ).rejects.toMatchObject({
        reason: 'media.not_pending',
      });
  }
  expect(await db().select().from(mediaEvidence)).toEqual([]);
});

test('an unknown media id and a caller that is not the scheduled system are refused by the policy', async () => {
  const principal = await systemPrincipal(db(), 'scheduled');
  expect(await authorize('media.scan', principal, { mediaId: '0190a000-0000-7000-8000-000000000000' })).toEqual({
    ok: false,
    reason: 'target.not_found',
  });
  const row = await seedMedia(store, { ownerId: uploader });
  const registration = await systemPrincipal(db(), 'registration');
  expect(await authorize('media.scan', registration, { mediaId: row.id })).toEqual({ ok: false, reason: 'auth.required' });
  expect(await authorize('media.scan', { kind: 'local', actorId: uploader, siteRole: 'admin' }, { mediaId: row.id })).toEqual({
    ok: false,
    reason: 'auth.required',
  });
});

test('the digest changes when the manifest does', async () => {
  const row = await seedMedia(store, { ownerId: uploader });
  await writer()
    .insert(mediaBlocklist)
    .values({ kind: 'sha256', value: sha256Of(row.bytes), category: 'other' });
  await scanNow(row.id, providerDeps());
  const [evidence] = await db().select().from(mediaEvidence);
  const manifest = evidence!.manifest as Manifest;
  expect(manifestDigest({ ...manifest, byteSize: (manifest.byteSize ?? 0) + 1 })).not.toBe(evidence!.manifestSha256);
});
