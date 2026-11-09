import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { deliveries } from '@peblish/core/delivery/tables';
import { writer } from '@peblish/core/db/write';
import { tx } from '@peblish/core/tx/tx';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { seedLocalInstance, seedSigningKey, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { BlockedDestinationError } from '../actors/safe-fetch.ts';
import { parseSignature, signatureVerifies } from '../signing/verify.ts';
import { maxAttempts, parseRetryAfter, retryDelaysMs, retryWindowMs, verdict } from './policy.ts';
import { enqueueDeliveries } from './queue.ts';
import { claimDue, deliverDue, type DeliveryOptions } from './run.ts';

const inbox = 'https://lemmy.test/inbox';
const body = JSON.stringify({
  type: 'Announce',
  id: 'https://fed-a.test/ap/activity/1',
  object: { type: 'Create', id: 'https://fed-a.test/ap/activity/0' },
});
const quiet: Pick<DeliveryOptions, 'refreshSoftware'> = { refreshSoftware: async () => {} };

async function world() {
  const { instance } = await seedLocalInstance();
  const remote = await seedInstance('lemmy.test', false);
  const community = await seedActor(instance, 'Group', 'news');
  const key = await seedSigningKey(community);
  const send = (inboxes: readonly string[] = [inbox], activityApId = 'https://fed-a.test/ap/activity/1', text = body) =>
    tx((t) => enqueueDeliveries(t, { activityApId, senderId: community.id, body: text, inboxes }));
  const rows = () => db().select().from(deliveries).orderBy(deliveries.createdAt);
  const makeDue = (id?: string) =>
    writer()
      .update(deliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1000), leaseUntil: null })
      .where(id ? eq(deliveries.id, id) : undefined);
  return { instance, remote, community, key, send, rows, makeDue };
}

beforeEach(truncateAll);

describe('the queue', () => {
  test('stores the exact body once per inbox, de-duplicates, drops what is not https, and ignores a second call', async () => {
    const w = await world();
    const added = await w.send([
      inbox,
      inbox,
      'https://other.test/inbox',
      'http://plain.test/inbox',
      'not a url',
      'https://u:p@creds.test/inbox',
    ]);
    expect(added).toBe(2);
    expect(await w.send([inbox])).toBe(0);
    const rows = await w.rows();
    expect(rows.map((row) => row.inboxUrl).sort()).toEqual(['https://lemmy.test/inbox', 'https://other.test/inbox']);
    expect(rows.every((row) => row.body === body && row.state === 'pending' && row.attempts === 0)).toBe(true);
    expect(rows.find((row) => row.inboxUrl === inbox)).toMatchObject({
      activityType: 'Announce',
      objectApId: 'https://fed-a.test/ap/activity/0',
      instanceId: w.remote.id,
      senderId: w.community.id,
    });
    expect(rows.find((row) => row.inboxUrl === 'https://other.test/inbox')?.instanceId).toBeNull();
  });

  test('nothing is written when the transaction is rolled back', async () => {
    const w = await world();
    await tx(async (t) => {
      await enqueueDeliveries(t, { activityApId: 'x', senderId: w.community.id, body, inboxes: [inbox] });
      throw new Error('rolled back');
    }).catch(() => {});
    expect(await w.rows()).toHaveLength(0);
  });
});

describe('delivering', () => {
  test('signs once with the sender’s key, POSTs the stored body without redirects, and records the 2xx', async () => {
    const w = await world();
    await w.send();
    const { fetch, requests } = stubFetch({ [inbox]: { status: 202, type: 'text/plain' } });
    expect(await deliverDue({ fetch, ...quiet })).toEqual({ delivered: 1, retried: 0, failed: 0, skipped: 0 });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({ url: inbox, method: 'POST', body });
    expect(request?.init).toMatchObject({ schemes: ['https:'], maxRedirects: 0, maxBytes: 65536, timeoutMs: 15000 });
    const headers = request!.headers;
    expect(headers.get('content-type')).toBe('application/activity+json');
    expect(headers.has('host')).toBe(false);
    const received = new Request(inbox, { method: 'POST', headers: { ...Object.fromEntries(headers), host: 'lemmy.test' }, body });
    const parsed = parseSignature(received, new TextEncoder().encode(body));
    expect(typeof parsed).toBe('object');
    expect(parsed).toMatchObject({ keyId: w.key.keyId });
    expect(signatureVerifies(parsed as Exclude<typeof parsed, string>, w.key.publicKeyPem)).toBe(true);
    expect((await w.rows())[0]).toMatchObject({ state: 'delivered', attempts: 1, lastStatus: 202, lastError: null, leaseUntil: null });
    expect((await w.rows())[0]?.settledAt).toBeInstanceOf(Date);
    expect(await deliverDue({ fetch, ...quiet })).toEqual({ delivered: 0, retried: 0, failed: 0, skipped: 0 });
  });

  test.each([400, 403, 404, 405, 410, 413, 422, 418, 301, 302, 307])('a %i stops the delivery for good', async (status) => {
    const w = await world();
    await w.send();
    const { fetch, requests } = stubFetch({
      [inbox]: { status, location: status >= 300 && status < 400 ? 'https://elsewhere.test/inbox' : undefined },
    });
    expect(await deliverDue({ fetch, ...quiet })).toMatchObject({ failed: 1, retried: 0 });
    expect((await w.rows())[0]).toMatchObject({ state: 'failed', attempts: 1, lastStatus: status });
    await w.makeDue();
    await deliverDue({ fetch, ...quiet });
    expect(requests).toHaveLength(1);
  });

  test('a redirect is recorded, not followed', async () => {
    const w = await world();
    await w.send();
    const { fetch, requests } = stubFetch({ [inbox]: { status: 301, location: 'https://127.0.0.1/inbox' } });
    await deliverDue({ fetch, ...quiet });
    expect(requests.map((request) => request.url)).toEqual([inbox]);
    expect((await w.rows())[0]).toMatchObject({ state: 'failed', lastError: 'redirect to https://127.0.0.1/inbox not followed' });
  });

  test.each([401, 408, 425, 429, 500, 502, 503, 504])('a %i is tried again later', async (status) => {
    const w = await world();
    await w.send();
    const { fetch } = stubFetch({ [inbox]: { status } });
    expect(await deliverDue({ fetch, ...quiet })).toMatchObject({ retried: 1, failed: 0 });
    const row = (await w.rows())[0]!;
    expect(row).toMatchObject({ state: 'pending', attempts: 1, lastStatus: status, leaseUntil: null });
    const wait = row.nextAttemptAt.getTime() - Date.now();
    expect(wait).toBeGreaterThan(retryDelaysMs[0] - 2000);
    expect(wait).toBeLessThanOrEqual(retryDelaysMs[0]);
    // Not due yet, so another run sends nothing.
    expect(await deliverDue({ fetch, ...quiet })).toMatchObject({ delivered: 0, retried: 0 });
  });

  test('a network failure is retried and a refused destination is not', async () => {
    const w = await world();
    await w.send([inbox, 'https://10.0.0.5/inbox']);
    const fetch = async (url: string | URL) => {
      if (String(url).includes('10.0.0.5')) throw new BlockedDestinationError('10.0.0.5 is a blocked address');
      throw new Error('ECONNRESET');
    };
    expect(await deliverDue({ fetch, ...quiet })).toMatchObject({ retried: 1, failed: 1 });
    const rows = await w.rows();
    expect(rows.find((row) => row.inboxUrl.includes('10.0.0.5'))).toMatchObject({
      state: 'failed',
      lastError: '10.0.0.5 is a blocked address',
    });
    expect(rows.find((row) => row.inboxUrl === inbox)).toMatchObject({ state: 'pending', lastError: 'ECONNRESET' });
  });

  test('the real fetcher refuses a private address, and the delivery fails for good', async () => {
    const w = await world();
    await w.send(['https://192.168.1.10/inbox', 'https://[::1]/inbox']);
    expect(await deliverDue({ ...quiet })).toMatchObject({ failed: 2, retried: 0 });
    expect((await w.rows()).map((row) => row.state)).toEqual(['failed', 'failed']);
  });

  test('retries back off by the schedule, and the tenth attempt is the last', async () => {
    const w = await world();
    await w.send();
    const { fetch, requests } = stubFetch({ [inbox]: { status: 503 } });
    const waits: number[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await w.makeDue();
      await deliverDue({ fetch, ...quiet });
      const row = (await w.rows())[0]!;
      if (row.state === 'pending') waits.push(Math.round((row.nextAttemptAt.getTime() - Date.now()) / 1000));
    }
    expect(requests).toHaveLength(maxAttempts);
    expect(waits).toEqual(retryDelaysMs.map((delay) => delay / 1000).map((seconds) => expect.closeTo(seconds, -1)));
    expect((await w.rows())[0]).toMatchObject({ state: 'failed', attempts: maxAttempts });
    await w.makeDue();
    await deliverDue({ fetch, ...quiet });
    expect(requests).toHaveLength(maxAttempts);
  });

  test('a dormant instance is skipped without a request, and one that is not is sent', async () => {
    const w = await world();
    await w.send([inbox, 'https://other.test/inbox']);
    const { fetch, requests } = stubFetch({ 'https://other.test/inbox': { status: 202 }, [inbox]: { status: 202 } });
    const counts = await deliverDue({ fetch, isDormant: async (id) => id === w.remote.id, ...quiet });
    expect(counts).toEqual({ delivered: 1, retried: 0, failed: 0, skipped: 1 });
    expect(requests.map((request) => request.url)).toEqual(['https://other.test/inbox']);
    expect((await w.rows()).find((row) => row.inboxUrl === inbox)).toMatchObject({
      state: 'skipped',
      lastError: 'the instance is dormant',
    });
  });

  test('a sender without a key, or with one that does not load, fails the delivery', async () => {
    const w = await world();
    const bare = await seedActor(w.instance, 'Group', 'bare');
    await tx((t) => enqueueDeliveries(t, { activityApId: 'https://fed-a.test/ap/activity/2', senderId: bare.id, body, inboxes: [inbox] }));
    const { fetch, requests } = stubFetch({});
    expect(await deliverDue({ fetch, ...quiet })).toMatchObject({ failed: 1 });
    expect((await w.rows())[0]?.lastError).toBe('the sender has no signing key');
    expect(requests).toHaveLength(0);
  });

  test('the instance’s NodeInfo is checked once per instance per run, before its first delivery', async () => {
    const w = await world();
    await w.send([inbox, 'https://lemmy.test/c/lab/inbox']);
    const asked: string[] = [];
    const { fetch } = stubFetch({ [inbox]: { status: 202 }, 'https://lemmy.test/c/lab/inbox': { status: 202 } });
    await deliverDue({ fetch, refreshSoftware: async (origin) => void asked.push(origin) });
    expect(asked).toEqual(['https://lemmy.test']);
  });
});

describe('leases and workers', () => {
  test('a row a live worker holds is not sent again, and one whose worker died is, once the lease runs out', async () => {
    const w = await world();
    await w.send();
    const { fetch, requests } = stubFetch({ [inbox]: { status: 202 } });
    // A worker claims the row and dies before it sends.
    expect(await claimDue(16, 60_000)).toHaveLength(1);
    expect((await w.rows())[0]).toMatchObject({ attempts: 1, state: 'pending' });
    expect(await deliverDue({ fetch, ...quiet })).toMatchObject({ delivered: 0 });
    expect(requests).toHaveLength(0);
    await writer()
      .update(deliveries)
      .set({ leaseUntil: new Date(Date.now() - 1000) });
    expect(await deliverDue({ fetch, ...quiet })).toMatchObject({ delivered: 1 });
    expect(requests).toHaveLength(1);
    expect((await w.rows())[0]).toMatchObject({ state: 'delivered', attempts: 2 });
  });

  test('two workers running together send each row once', async () => {
    const w = await world();
    const inboxes = Array.from({ length: 12 }, (_, index) => `https://peer${index}.test/inbox`);
    await w.send(inboxes);
    const { fetch, requests } = stubFetch(Object.fromEntries(inboxes.map((url) => [url, { status: 202 }])));
    const [a, b] = await Promise.all([deliverDue({ fetch, batchSize: 3, ...quiet }), deliverDue({ fetch, batchSize: 3, ...quiet })]);
    expect(a.delivered + b.delivered).toBe(12);
    expect(requests.map((request) => request.url).sort()).toEqual([...inboxes].sort());
  });

  /** Runs a worker that stops at `pauseAt` until released; the row's lease is then expired and another worker takes over. */
  async function takeover(pauseAt: 'before the send' | 'during the send') {
    const w = await world();
    await w.send();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const stalled = new Promise<void>((resolve) => (reached = resolve));
    const slow = stubFetch({ [inbox]: { status: 503 } });
    const first = deliverDue({
      fetch: async (url, init) => {
        reached();
        await paused;
        return slow.fetch(url, init);
      },
      refreshSoftware: async () => {
        if (pauseAt === 'before the send') {
          reached();
          await paused;
        }
      },
    });
    await stalled;
    expect((await w.rows())[0]).toMatchObject({ attempts: 1, state: 'pending' });
    // The first worker is past its lease; a second one claims the row and delivers it.
    await writer()
      .update(deliveries)
      .set({ leaseUntil: new Date(Date.now() - 1000) });
    const second = stubFetch({ [inbox]: { status: 202 } });
    expect(await deliverDue({ fetch: second.fetch, ...quiet })).toMatchObject({ delivered: 1 });
    release();
    return { w, first: await first, slow, second };
  }

  test('a worker that wakes up after its lease ran out cannot put a delivered row back to pending', async () => {
    const { w, first, slow, second } = await takeover('during the send');
    // It had already sent (a duplicate the receiver dedupes), but its 503 is not recorded.
    expect(slow.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(first).toEqual({ delivered: 0, retried: 0, failed: 0, skipped: 0 });
    expect((await w.rows())[0]).toMatchObject({ state: 'delivered', attempts: 2, lastStatus: 202, lastError: null });
  });

  test('a worker that wakes up before its send finds the row taken over and sends nothing', async () => {
    const { w, first, slow, second } = await takeover('before the send');
    expect(slow.requests).toHaveLength(0);
    expect(second.requests).toHaveLength(1);
    expect(first).toEqual({ delivered: 0, retried: 0, failed: 0, skipped: 0 });
    expect((await w.rows())[0]).toMatchObject({ state: 'delivered', attempts: 2 });
  });

  test('a worker renews its lease just before it sends', async () => {
    const w = await world();
    await w.send();
    const answer = stubFetch({ [inbox]: { status: 202 } });
    let leaseAtSend: Date | null = null;
    const counts = await deliverDue({
      fetch: async (url, init) => {
        leaseAtSend = (await w.rows())[0]!.leaseUntil;
        return answer.fetch(url, init);
      },
      // The lease is nearly out by the time the NodeInfo check is done.
      refreshSoftware: async () => {
        await writer()
          .update(deliveries)
          .set({ leaseUntil: new Date(Date.now() + 100) });
      },
    });
    expect(counts).toMatchObject({ delivered: 1 });
    expect(leaseAtSend!.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  test('a stopped worker claims nothing', async () => {
    const w = await world();
    await w.send();
    const controller = new AbortController();
    controller.abort();
    const { fetch, requests } = stubFetch({});
    expect(await deliverDue({ fetch, signal: controller.signal, ...quiet })).toEqual({ delivered: 0, retried: 0, failed: 0, skipped: 0 });
    expect(requests).toHaveLength(0);
    expect((await w.rows())[0]?.attempts).toBe(0);
  });
});

describe('the retry policy', () => {
  test('the schedule is capped at six hours and sums to about fifteen', () => {
    expect(Math.max(...retryDelaysMs)).toBe(6 * 3600_000);
    expect(retryDelaysMs).toHaveLength(maxAttempts - 1);
    expect(retryWindowMs / 3600_000).toBeCloseTo(15.04, 2);
  });

  test('a peer’s Retry-After lengthens a wait but never past six hours or below the schedule', () => {
    expect(verdict(1, { status: 429, retryAfterMs: 120_000 })).toEqual({ state: 'pending', delayMs: 120_000 });
    expect(verdict(1, { status: 429, retryAfterMs: 1000 })).toEqual({ state: 'pending', delayMs: 10_000 });
    expect(verdict(1, { status: 503, retryAfterMs: 99 * 3600_000 })).toEqual({ state: 'pending', delayMs: 6 * 3600_000 });
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter(new Date(Date.now() + 90_000).toUTCString())).toBeGreaterThan(80_000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });

  test('a day-one-cap style refusal (a 4xx) is final, not retried', () => {
    expect(verdict(1, { status: 400, retryAfterMs: null })).toEqual({ state: 'failed' });
    expect(verdict(1, { status: 429, retryAfterMs: null })).toMatchObject({ state: 'pending' });
  });
});
