import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { outbox } from '../db/tables/outbox.ts';
import { writer } from '../db/write.ts';
import { ensureCursors, processBatch } from '../outbox/worker.ts';
import { truncateAll } from '../testing/db.ts';
import { seedLocalInstance } from '../testing/seed-a.ts';
import { tx } from '../tx/tx.ts';
import type { HttpFetch } from './cloudflare.ts';
import { consumer } from './consumer.ts';
import { owePurgeAfterRestore, owePurges, owedRows } from './debt.ts';
import { purgePathReady } from './ready.ts';
import { claimPurges, flushPurges, startPurge } from './send.ts';
import { edgePurges, edgeStatus } from './tables.ts';
import type { Purge } from './tags.ts';
import { ECHO_MS, LEASE_MS, MAX_OWED, SEND_GAP_MS } from './timing.ts';

// Every time the purge path stores or compares is the database's, so these tests move time by
// shifting what is stored back (rewind) rather than by giving the code a clock.

const token = 'tok_' + 'S3cr3t'.repeat(6);
const zone = '0123456789abcdef0123456789abcdef';
const config = { zoneId: zone, token };

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
const flush = (fetch: HttpFetch) => flushPurges(config, { fetch });

/** As if `ms` had passed: every stored time moves back by it. */
async function rewind(ms: number) {
  const by = sql.raw(`interval '${ms} milliseconds'`);
  await writer()
    .update(edgePurges)
    .set({ dueAt: sql`${edgePurges.dueAt} - ${by}`, leaseUntil: sql`${edgePurges.leaseUntil} - ${by}` });
  await writer()
    .update(edgeStatus)
    .set({
      verifiedAt: sql`${edgeStatus.verifiedAt} - ${by}`,
      sentAt: sql`${edgeStatus.sentAt} - ${by}`,
      retryAt: sql`${edgeStatus.retryAt} - ${by}`,
      leaseUntil: sql`${edgeStatus.leaseUntil} - ${by}`,
    });
}

function captureLogs() {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(' ')));
  }
  return lines;
}

async function grants() {
  const principal = await systemPrincipal(db(), 'scheduled');
  const claim = await authorize('edge.purge_claim', principal, {});
  if (!claim.ok) throw new Error(claim.reason);
  return { principal, claim: claim.grant };
}

test('every purge is sent twice: as soon as the rate allows, and again ECHO_MS after its first send succeeded', async () => {
  const fetch = vi.fn<HttpFetch>(async () => ok());
  await owe(['pbm-p-1', 'pbm-c-2']);
  expect(await flush(fetch)).toBe('sent');
  expect((await owed()).toSorted()).toEqual([
    ['pbm-c-2', 2],
    ['pbm-p-1', 2],
  ]);
  await rewind(ECHO_MS - 5_000);
  expect(await flush(fetch)).toBe('idle');
  await rewind(5_000);
  expect(await flush(fetch)).toBe('sent');
  expect(sentTags(fetch).map((tags) => tags.toSorted())).toEqual([
    ['pbm-c-2', 'pbm-p-1'],
    ['pbm-c-2', 'pbm-p-1'],
  ]);
  // The echo itself is not echoed.
  expect(await owed()).toEqual([]);
});

test('a send settles only the batch it took: the same tag, or a new one, owed while it was in flight stays owed', async () => {
  await owe(['pbm-p-1']);
  const fetch = vi.fn<HttpFetch>(async () => {
    await owe(['pbm-p-1', 'pbm-a-9']);
    return ok();
  });
  expect(await flush(fetch)).toBe('sent');
  expect((await owed()).toSorted()).toEqual([
    ['pbm-a-9', 1],
    ['pbm-p-1', 1],
    ['pbm-p-1', 2],
  ]);
  await writer().delete(edgePurges);
  await owe('all');
  const wide = vi.fn<HttpFetch>(async () => {
    await owe(['pbm-x-abc']);
    return ok();
  });
  await rewind(SEND_GAP_MS);
  await flush(wide);
  expect(sentTags(wide)).toEqual([['pbm']]);
  expect((await owed()).toSorted()).toEqual([
    ['pbm', 2],
    ['pbm-x-abc', 1],
  ]);
});

test('requests are spaced SEND_GAP_MS apart across workers, and only one of two concurrent senders sends', async () => {
  await owe(['a']);
  const fetch = vi.fn<HttpFetch>(async () => ok());
  expect((await Promise.all([flush(fetch), flush(fetch)])).toSorted()).toEqual(['idle', 'sent']);
  await owe(['b']);
  await rewind(SEND_GAP_MS - 2_000);
  expect(await flush(fetch)).toBe('idle');
  await rewind(2_000);
  expect(await flush(fetch)).toBe('sent');
  expect(sentTags(fetch)).toEqual([['a'], ['b']]);
});

test('a sender that dies after its claim leaves the rows to another worker once its lease runs out', async () => {
  await owe(['pbm-p-1']);
  const { claim } = await grants();
  // Worker A claims and never sends.
  expect(await claimPurges(claim, { zoneId: zone })).toMatchObject({ kind: 'purge', purge: ['pbm-p-1'] });
  const fetch = vi.fn<HttpFetch>(async () => ok());
  // While A's batch is in flight nobody else claims.
  expect(await flush(fetch)).toBe('idle');
  await rewind(LEASE_MS);
  expect(await flush(fetch)).toBe('sent');
  expect(sentTags(fetch)).toEqual([['pbm-p-1']]);
});

test('a sender that paused after its claim and lost its batch does not send when it resumes (round 3, item 5)', async () => {
  await owe(['pbm-p-1']);
  const { principal, claim } = await grants();
  const paused = await claimPurges(claim, { zoneId: zone });
  if (!paused) throw new Error('nothing claimed');
  // A pauses past its lease; B claims the rows again and sends.
  await rewind(LEASE_MS);
  const fetch = vi.fn<HttpFetch>(async () => ok());
  expect(await flush(fetch)).toBe('sent');
  // A resumes: its request is not let out, so two requests never go at once.
  const settle = await authorize('edge.purge_settle', principal, { token: paused.token });
  if (!settle.ok) throw new Error(settle.reason);
  expect(await startPurge(settle.grant)).toBe(false);
});

test('expired claims of one tag by two dead senders coalesce, and the queue keeps sending (round 3, item 1)', async () => {
  const fetch = vi.fn<HttpFetch>(async () => ok());
  const past = sql`now() - interval '1 minute'`;
  // Worker A claimed X; X was owed again; worker B claimed that row; both died. Plus a dead
  // sender's echo of Y beside an unclaimed echo of Y due later, which must keep the later time.
  await writer()
    .insert(edgePurges)
    .values([
      { tag: 'X', claimToken: '0195f0a0-0000-7000-8000-00000000000a', leaseUntil: past },
      { tag: 'X', claimToken: '0195f0a0-0000-7000-8000-00000000000b', leaseUntil: past },
      { tag: 'X', claimToken: '0195f0a0-0000-7000-8000-00000000000d', leaseUntil: past },
      {
        tag: 'Y',
        send: 2,
        dueAt: sql`now() + interval '10 minutes'`,
        claimToken: '0195f0a0-0000-7000-8000-00000000000c',
        leaseUntil: past,
      },
      { tag: 'Y', send: 2, dueAt: sql`now() + interval '20 minutes'` },
    ]);
  expect(await flush(fetch)).toBe('sent');
  expect(sentTags(fetch)).toEqual([['X']]);
  const rows = await db().select({ tag: edgePurges.tag, send: edgePurges.send, dueAt: edgePurges.dueAt }).from(edgePurges);
  expect(rows.map(({ tag, send }) => [tag, send]).toSorted()).toEqual([
    ['X', 2],
    ['Y', 2],
  ]);
  expect(rows.find((row) => row.tag === 'Y')!.dueAt.getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);
});

test('the debt is bounded: first sends collapse past MAX_OWED, echoes never cause that, and echoes collapse on their own', async () => {
  await owe(Array.from({ length: MAX_OWED }, (_, i) => `t${i}`));
  expect((await owed()).length).toBe(MAX_OWED);
  await owe(['one-more']);
  expect(await owed()).toEqual([['pbm', 1]]);
  await writer().delete(edgePurges);

  // 100 echoes owed, then 100 new first sends: no collapse of the first sends.
  await writer()
    .insert(edgePurges)
    .values(Array.from({ length: MAX_OWED }, (_, i) => ({ tag: `e${i}`, send: 2, dueAt: sql`now() + interval '1 minute'` })));
  await owe(Array.from({ length: MAX_OWED }, (_, i) => `f${i}`));
  expect((await owed()).filter(([, send]) => send === 1).length).toBe(MAX_OWED);
  // Sending them adds 100 more echoes, which collapse into one wide echo.
  const fetch = vi.fn<HttpFetch>(async () => ok());
  expect(await flush(fetch)).toBe('sent');
  expect(await owed()).toEqual([['pbm', 2]]);
});

async function prove() {
  const fetch = vi.fn<HttpFetch>(async () => ok());
  expect(await flush(fetch)).toBe('sent');
  expect(sentTags(fetch)).toEqual([['pbm-check']]);
}

test('web answers public only while the purge path is proven for its zone, nothing is late, and the consumer keeps up (items 4, 5)', async () => {
  const ready = (zoneId = zone) => purgePathReady(db(), zoneId);
  await ensureCursors([consumer]);
  expect(await ready()).toBe(false);
  // Nothing owed: the idle check proves the token.
  await prove();
  expect(await ready()).toBe(true);
  // Web configured for another zone than the worker proved.
  expect(await ready('fedcba9876543210fedcba9876543210')).toBe(false);
  // A stale record.
  await rewind(6 * 60_000);
  expect(await ready()).toBe(false);
  await writer()
    .update(edgeStatus)
    .set({ verifiedAt: sql`now()` })
    .where(eq(edgeStatus.name, 'cloudflare'));
  expect(await ready()).toBe(true);
  // Debt due longer ago than DEBT_LATE_MS and unpaid.
  await writer()
    .insert(edgePurges)
    .values({ tag: 'late', dueAt: sql`now() - interval '3 minutes'` });
  expect(await ready()).toBe(false);
  await writer().delete(edgePurges);
  expect(await ready()).toBe(true);
  // An outbox event the consumer has not passed, older than CONSUMER_LATE_MS (a stuck consumer, or the horizon held back).
  await tx((t) =>
    t.emit({
      type: 'settings.updated',
      v: 1,
      keys: ['site.name'],
      actorId: '0195f0a0-0000-7000-8000-000000000001',
      modlogId: '0195f0a0-0000-7000-8000-000000000002',
    }),
  );
  await writer()
    .update(outbox)
    .set({ createdAt: sql`now() - interval '1 minute'` });
  expect(await ready()).toBe(false);
  // Once the consumer has passed it, ready again.
  await vi.waitFor(async () => {
    await processBatch(consumer);
    expect(await ready()).toBe(true);
  });
  // No cursor at all (the consumer never ran): not ready.
  await writer().execute(sql`delete from outbox_cursors where consumer = 'edge.purge'`);
  expect(await ready()).toBe(false);
});

test('a restore owes a purge of everything that keeps web private until it is sent (round 3, item 6)', async () => {
  await ensureCursors([consumer]);
  await prove();
  expect(await purgePathReady(db(), zone)).toBe(true);
  await tx((t) => owePurgeAfterRestore(t.db));
  expect(await purgePathReady(db(), zone)).toBe(false);
  const fetch = vi.fn<HttpFetch>(async () => ok());
  await rewind(SEND_GAP_MS);
  expect(await flush(fetch)).toBe('sent');
  expect(sentTags(fetch)).toEqual([['pbm']]);
  expect(await purgePathReady(db(), zone)).toBe(true);
});

test('a refused token is not ready at once and is logged at once, every time, never with the token', async () => {
  const lines = captureLogs();
  await ensureCursors([consumer]);
  await prove();
  expect(await purgePathReady(db(), zone)).toBe(true);
  await owe(['pbm-p-1']);
  const refused = vi.fn<HttpFetch>(async () => answer(403, { success: false, errors: [{ code: 10000, message: `bad ${token}` }] }));
  await rewind(SEND_GAP_MS);
  expect(await flush(refused)).toBe('failed');
  expect(await purgePathReady(db(), zone)).toBe(false);
  expect(await owed()).toEqual([['pbm-p-1', 1]]);
  await rewind(5 * 60_000);
  await flush(refused);
  expect(lines).toEqual([
    'edge cache: Cloudflare refused the purge request (http 403 (cloudflare 10000)); proxy images are answered private until it works',
    'edge cache: Cloudflare refused the purge request (http 403 (cloudflare 10000)); proxy images are answered private until it works',
  ]);
  await rewind(5 * 60_000);
  await flush(vi.fn<HttpFetch>(async () => ok()));
  expect(lines.at(-1)).toBe('edge cache: purge path works again after 2 failed requests');
  expect(lines.join('\n')).not.toContain(token);
  // One outbox record for the run of failures, not one per failure.
  const [failed] = await db().execute<{ n: number }>(sql`select count(*)::int as n from outbox where type = 'edge.purge_failed'`);
  expect(failed?.n).toBe(1);
});

test('other failures keep the debt, back off, and are logged at the first and each doubling', async () => {
  const lines = captureLogs();
  await owe(['x']);
  const down = vi.fn<HttpFetch>(async () => {
    throw new TypeError(`fetch failed ${token}`);
  });
  for (let i = 0; i < 4; i++) {
    expect(await flush(down)).toBe('failed');
    await rewind(5 * 60_000);
  }
  expect(lines).toEqual([
    'edge cache: purge request failed 1 time in a row (TypeError); the debt stays owed',
    'edge cache: purge request failed 2 times in a row (TypeError); the debt stays owed',
    'edge cache: purge request failed 4 times in a row (TypeError); the debt stays owed',
  ]);
  // Inside the backoff nothing is sent; a 429's Retry-After is honoured too.
  const limited = vi.fn<HttpFetch>(async () => answer(429, { success: false }, { 'retry-after': '120' }));
  await flush(limited);
  await rewind(110_000);
  expect(await flush(limited)).toBe('idle');
  expect(await owed()).toEqual([['x', 1]]);
});
