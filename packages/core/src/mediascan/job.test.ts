import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { media } from '../db/tables/media.ts';
import { writer } from '../db/write.ts';
import { memoryStore } from '../storage/memory.ts';
import { truncateAll } from '../testing/db.ts';
import { seedLocalInstance } from '../testing/seed-a.ts';
import { seedMedia, startArachnidStub, type ArachnidStub } from '../testing/seed-safe.ts';
import { scanConfig } from './config.ts';
import { scanPending } from './job.ts';
import { claimScan, dueBatch, scanLimits } from './record.ts';
import { mediaScans } from './tables.ts';

let stub: ArachnidStub;
beforeAll(async () => {
  stub = await startArachnidStub();
});
afterAll(() => stub.close());
beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
  stub.requests.length = 0;
  stub.onMedia(() => ({ json: { classification: 'no-known-match' } }));
});

const store = memoryStore();
const config = () =>
  scanConfig({
    ARACHNID_USERNAME: stub.username,
    ARACHNID_PASSWORD: stub.password,
    ARACHNID_BASE_URL: stub.baseUrl,
    MEDIASCAN_TIMEOUT_MS: '600',
  });
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const stateOf = async (id: string) => (await db().select().from(media).where(eq(media.id, id)))[0]!.scanState;

async function claim(now = new Date(), mediaId: string | null = null) {
  const decision = await authorize('media.scan_claim', await systemPrincipal(db(), 'scheduled'), { mediaId });
  if (!decision.ok) throw new Error(decision.reason);
  return claimScan(decision.grant, { now });
}

test('the backstop takes only pending rows over 30 seconds old, oldest first', async () => {
  const old = await seedMedia(store, { createdAt: minutesAgo(5) });
  const older = await seedMedia(store, { createdAt: minutesAgo(10) });
  await seedMedia(store, { createdAt: new Date() }); // the inline scan of an upload in flight
  await seedMedia(store, { createdAt: minutesAgo(20), state: 'clean' });
  expect((await claim()).map((c) => c.mediaId)).toEqual([older.id, old.id]);
});

test('a leased row is not taken again until the lease ends, and each take counts an attempt', async () => {
  const row = await seedMedia(store, { createdAt: minutesAgo(5) });
  const now = new Date();
  expect(await claim(now)).toEqual([{ mediaId: row.id, attempts: 1 }]);
  expect(await claim(new Date(now.getTime() + scanLimits.leaseMs - 1))).toEqual([]);
  expect(await claim(new Date(now.getTime() + scanLimits.leaseMs + 1))).toEqual([{ mediaId: row.id, attempts: 2 }]);
});

test('two workers claiming at once take disjoint rows and together take every due row once', async () => {
  const ids = new Set<string>();
  for (let i = 0; i < 30; i++) ids.add((await seedMedia(store, { createdAt: minutesAgo(5 + i) })).id);
  const results = await Promise.all([claim(), claim(), claim()]);
  const taken = results.flat().map((c) => c.mediaId);
  expect(new Set(taken).size).toBe(taken.length);
  expect(taken.length).toBeLessThanOrEqual(3 * scanLimits.batch);
  expect(taken.length).toBe(30);
  expect(new Set(taken)).toEqual(ids);
});

test('the inline claim takes one named row of any age, and only while it is pending', async () => {
  const fresh = await seedMedia(store, { createdAt: new Date() });
  const clean = await seedMedia(store, { state: 'clean' });
  expect(await claim(new Date(), fresh.id)).toEqual([{ mediaId: fresh.id, attempts: 1 }]);
  expect(await claim(new Date(), clean.id)).toEqual([]);
});

test('a provider outage leaves the row pending for later tries and the fifth failure makes it failed', async () => {
  const row = await seedMedia(store, { createdAt: minutesAgo(5) });
  stub.onMedia(() => ({ status: 503, json: {} }));
  const start = Date.now();
  for (let attempt = 1; attempt < scanLimits.maxAttempts; attempt++) {
    expect(await scanPending({ store, config: config(), now: () => new Date(start + attempt * 2 * scanLimits.leaseMs) })).toBe(1);
    expect([attempt, await stateOf(row.id)]).toEqual([attempt, 'pending']);
  }
  await scanPending({ store, config: config(), now: () => new Date(start + scanLimits.maxAttempts * 2 * scanLimits.leaseMs) });
  expect(await stateOf(row.id)).toBe('failed');
  const [scan] = await db().select().from(mediaScans).where(eq(mediaScans.mediaId, row.id));
  expect(scan).toMatchObject({ attempts: scanLimits.maxAttempts, leaseUntil: null, lastError: 'arachnid: Arachnid answered HTTP 503' });
});

test('a bucket read failure is retried like an outage, and the fifth attempt settles the row as failed', async () => {
  const row = await seedMedia(store, { createdAt: minutesAgo(5) });
  const broken = { ...store, get: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:18490')) };
  const start = Date.now();
  for (let attempt = 1; attempt < scanLimits.maxAttempts; attempt++) {
    expect(await scanPending({ store: broken, config: config(), now: () => new Date(start + attempt * 2 * scanLimits.leaseMs) })).toBe(1);
    expect([attempt, await stateOf(row.id)]).toEqual([attempt, 'pending']);
  }
  await scanPending({ store: broken, config: config(), now: () => new Date(start + scanLimits.maxAttempts * 2 * scanLimits.leaseMs) });
  expect(await stateOf(row.id)).toBe('failed');
  const [scan] = await db().select().from(mediaScans).where(eq(mediaScans.mediaId, row.id));
  expect(scan).toMatchObject({ attempts: scanLimits.maxAttempts, leaseUntil: null, lastError: 'the stored object could not be read' });
  expect(stub.requests).toEqual([]);
});

test('with no provider configured the backstop fails a row at once rather than retrying it', async () => {
  const row = await seedMedia(store, { createdAt: minutesAgo(5) });
  await scanPending({ store, config: scanConfig({}) });
  expect(await stateOf(row.id)).toBe('failed');
});

test('the backstop recovers a row the inline scan abandoned and scans it', async () => {
  const row = await seedMedia(store, { createdAt: minutesAgo(5) });
  await scanPending({ store, config: config() });
  expect(await stateOf(row.id)).toBe('clean');
});

test('the claim is served by the partial index media_scan_pending among 100,000 rows', async () => {
  await writer().execute(sql`
    insert into media (id, kind, scan_state, created_at)
    select gen_random_uuid(), 'upload', case when n % 5000 = 0 then 'pending' else 'clean' end, now() - make_interval(secs => n)
    from generate_series(1, 100000) n`);
  await writer().execute(sql`analyze media`);
  const plan = (await db().execute<{ 'QUERY PLAN': string }>(sql`explain ${dueBatch(new Date())}`))
    .map((row) => row['QUERY PLAN'])
    .join('\n');
  expect(plan).toContain('media_scan_pending');
  expect(plan).not.toMatch(/Seq Scan on media /);
}, 60_000);
