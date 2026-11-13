import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { db } from '../db/read.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedLocalInstance } from '../testing/seed-a.ts';
import { tx } from '../tx/tx.ts';
import type { HttpFetch } from './cloudflare.ts';
import { owePurges, owedRows } from './debt.ts';
import { purgePathReady } from './ready.ts';
import { flushPurges } from './send.ts';
import { edgePurges, edgeStatus } from './tables.ts';
import type { Purge } from './tags.ts';
import { CHECK_AFTER_MS, ECHO_MS, LEASE_MS, MAX_OWED, SEND_GAP_MS } from './timing.ts';

const token = 'tok_' + 'S3cr3t'.repeat(6);
const config = { zoneId: '0123456789abcdef0123456789abcdef', token };

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});
afterEach(() => vi.restoreAllMocks());

const owe = (purge: Purge) => tx((t) => owePurges(t.db, purge));
const owed = async () => (await owedRows(db())).map(({ tag, send }) => [tag, send]);
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = () => answer(200, { success: true, errors: [] });
const sentTags = (fetch: { mock: { calls: unknown[][] } }) =>
  fetch.mock.calls.map((call) => (JSON.parse(String((call[1] as RequestInit).body)) as { tags: string[] }).tags);

/** A clock for the claim and settle, starting a second ahead of the database so rows owed now are due. */
function clock() {
  let at = Date.now() + 1_000;
  return { now: () => new Date(at), advance: (ms: number) => (at += ms) };
}

function captureLogs() {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(' ')));
  }
  return lines;
}

test('every purge is sent twice: as soon as the rate allows, and again ECHO_MS after its first send succeeded', async () => {
  const fetch = vi.fn<HttpFetch>(async () => ok());
  const time = clock();
  await owe(['pbm-p-1', 'pbm-c-2']);
  expect(await flushPurges(config, { fetch, now: time.now })).toBe('sent');
  expect(await owed()).toEqual([
    ['pbm-c-2', 2],
    ['pbm-p-1', 2],
  ]);
  time.advance(ECHO_MS - 1);
  expect(await flushPurges(config, { fetch, now: time.now })).toBe('idle');
  time.advance(1);
  expect(await flushPurges(config, { fetch, now: time.now })).toBe('sent');
  expect(sentTags(fetch)).toEqual([
    ['pbm-p-1', 'pbm-c-2'],
    ['pbm-c-2', 'pbm-p-1'],
  ]);
  // The echo itself is not echoed.
  expect(await owed()).toEqual([]);
});

test('a send settles only the batch it took: the same tag, or a new one, owed while it was in flight stays owed (item 4)', async () => {
  const time = clock();
  await owe(['pbm-p-1']);
  const fetch = vi.fn<HttpFetch>(async () => {
    // A takedown commits while the request is out.
    await owe(['pbm-p-1', 'pbm-a-9']);
    return ok();
  });
  expect(await flushPurges(config, { fetch, now: time.now })).toBe('sent');
  expect(await owed()).toEqual(
    expect.arrayContaining([
      ['pbm-p-1', 1],
      ['pbm-a-9', 1],
      ['pbm-p-1', 2],
    ]),
  );
  expect((await owed()).length).toBe(3);
  // The same holds for a wide purge: what came in meanwhile is not cleared by it.
  await tx((t) => t.db.delete(edgePurges));
  await owe('all');
  const wide = vi.fn<HttpFetch>(async () => {
    await owe(['pbm-x-abc']);
    return ok();
  });
  time.advance(SEND_GAP_MS);
  await flushPurges(config, { fetch: wide, now: time.now });
  expect(sentTags(wide)).toEqual([['pbm']]);
  expect(await owed()).toEqual(
    expect.arrayContaining([
      ['pbm-x-abc', 1],
      ['pbm', 2],
    ]),
  );
});

test('requests are spaced SEND_GAP_MS apart across workers, and only one of two concurrent senders sends (item 8)', async () => {
  const time = clock();
  await owe(['a']);
  const fetch = vi.fn<HttpFetch>(async () => ok());
  const both = await Promise.all([flushPurges(config, { fetch, now: time.now }), flushPurges(config, { fetch, now: time.now })]);
  expect(both.toSorted()).toEqual(['idle', 'sent']);
  await owe(['b']);
  time.advance(SEND_GAP_MS - 1);
  expect(await flushPurges(config, { fetch, now: time.now })).toBe('idle');
  time.advance(1);
  expect(await flushPurges(config, { fetch, now: time.now })).toBe('sent');
  expect(sentTags(fetch)).toEqual([['a'], ['b']]);
});

test('a sender that dies after its claim leaves the rows to another worker once its lease runs out (item 8)', async () => {
  const time = clock();
  await owe(['pbm-p-1']);
  // Worker A claims and never settles.
  const hung = vi.fn<HttpFetch>(() => new Promise<Response>(() => {}));
  void flushPurges(config, { fetch: hung, now: time.now });
  await vi.waitFor(() => expect(hung).toHaveBeenCalled());
  const fetch = vi.fn<HttpFetch>(async () => ok());
  time.advance(SEND_GAP_MS);
  // Still leased: nothing to send, and the token is not yet proven, so it is the idle check.
  expect(await flushPurges(config, { fetch, now: time.now })).toBe('sent');
  expect(sentTags(fetch)).toEqual([['pbm-check']]);
  time.advance(LEASE_MS);
  expect(await flushPurges(config, { fetch, now: time.now })).toBe('sent');
  expect(sentTags(fetch)).toEqual([['pbm-check'], ['pbm-p-1']]);
});

test('the debt is bounded: past MAX_OWED unclaimed rows it collapses into one wide purge (item 9)', async () => {
  await owe(Array.from({ length: MAX_OWED }, (_, i) => `t${i}`));
  expect((await owed()).length).toBe(MAX_OWED);
  await owe(['one-more']);
  expect(await owed()).toEqual([['pbm', 1]]);
  await owe(Array.from({ length: 500 }, (_, i) => `u${i}`));
  expect(await owed()).toEqual([['pbm', 1]]);
});

test('web answers public only while a fresh record shows the purge path works and no debt is late (item 5)', async () => {
  const ready = () => purgePathReady(db());
  const time = clock();
  // No record: private.
  expect(await ready()).toBe(false);
  const fetch = vi.fn<HttpFetch>(async () => ok());
  // Nothing owed: the idle check proves the token.
  expect(await flushPurges(config, { fetch, now: time.now })).toBe('sent');
  expect(sentTags(fetch)).toEqual([['pbm-check']]);
  expect(await ready()).toBe(true);
  // Proven recently: no further check.
  time.advance(CHECK_AFTER_MS - 1);
  expect(await flushPurges(config, { fetch, now: time.now })).toBe('idle');
  // A stale record is not ready.
  await writer()
    .update(edgeStatus)
    .set({ verifiedAt: sql`now() - interval '6 minutes'` })
    .where(eq(edgeStatus.name, 'cloudflare'));
  expect(await ready()).toBe(false);
  await writer()
    .update(edgeStatus)
    .set({ verifiedAt: sql`now()` })
    .where(eq(edgeStatus.name, 'cloudflare'));
  expect(await ready()).toBe(true);
  // Debt due longer ago than DEBT_LATE_MS and unpaid is not ready either.
  await writer()
    .insert(edgePurges)
    .values({ tag: 'late', dueAt: sql`now() - interval '3 minutes'` });
  expect(await ready()).toBe(false);
});

test('a refused token is not ready at once and is logged at once, every time, never with the token (item 5)', async () => {
  const lines = captureLogs();
  const time = clock();
  const good = vi.fn<HttpFetch>(async () => ok());
  await flushPurges(config, { fetch: good, now: time.now });
  expect(await purgePathReady(db())).toBe(true);
  await owe(['pbm-p-1']);
  const refused = vi.fn<HttpFetch>(async () => answer(403, { success: false, errors: [{ code: 10000, message: `bad ${token}` }] }));
  time.advance(SEND_GAP_MS);
  expect(await flushPurges(config, { fetch: refused, now: time.now })).toBe('failed');
  expect(await purgePathReady(db())).toBe(false);
  expect(await owed()).toEqual([['pbm-p-1', 1]]);
  time.advance(5 * 60_000);
  await flushPurges(config, { fetch: refused, now: time.now });
  expect(lines).toEqual([
    'edge cache: Cloudflare refused the purge request (http 403 (cloudflare 10000)); proxy images are answered private until it works',
    'edge cache: Cloudflare refused the purge request (http 403 (cloudflare 10000)); proxy images are answered private until it works',
  ]);
  time.advance(5 * 60_000);
  await flushPurges(config, { fetch: good, now: time.now });
  expect(lines.at(-1)).toBe('edge cache: purge path works again after 2 failed requests');
  expect(lines.join('\n')).not.toContain(token);
  // Each failure is also an outbox record for operators.
  const [failed] = await db().execute<{ n: number }>(sql`select count(*)::int as n from outbox where type = 'edge.purge_failed'`);
  expect(failed?.n).toBe(2);
});

test('other failures keep the debt, back off, and are logged at the first and each doubling', async () => {
  const lines = captureLogs();
  const time = clock();
  await owe(['x']);
  const down = vi.fn<HttpFetch>(async () => {
    throw new TypeError(`fetch failed ${token}`);
  });
  for (let i = 0; i < 4; i++) {
    expect(await flushPurges(config, { fetch: down, now: time.now })).toBe('failed');
    time.advance(5 * 60_000);
  }
  expect(lines).toEqual([
    'edge cache: purge request failed 1 time in a row (TypeError); the debt stays owed',
    'edge cache: purge request failed 2 times in a row (TypeError); the debt stays owed',
    'edge cache: purge request failed 4 times in a row (TypeError); the debt stays owed',
  ]);
  // Inside the backoff nothing is sent; a 429's Retry-After is honoured too.
  const limited = vi.fn<HttpFetch>(async () => answer(429, { success: false }, { 'retry-after': '120' }));
  await flushPurges(config, { fetch: limited, now: time.now });
  time.advance(119_000);
  expect(await flushPurges(config, { fetch: limited, now: time.now })).toBe('idle');
  expect(await owed()).toEqual([['x', 1]]);
});
