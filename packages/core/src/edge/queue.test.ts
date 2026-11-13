import { afterEach, expect, test, vi } from 'vitest';
import { purgeTags, type HttpFetch } from './cloudflare.ts';
import { edgeConfig } from './config.ts';
import { createPurgeQueue, WIDE_ECHO_MS } from './queue.ts';

const token = 'tok_' + 'S3cr3t'.repeat(6);
const config = { zoneId: '0123456789abcdef0123456789abcdef', token };

afterEach(() => vi.restoreAllMocks());

/** Everything any console method printed during the test. */
function captureLogs() {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(' ')));
  }
  return lines;
}

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('edge caching is off unless both variables are set and well formed, and a bad pair is named, never quoted', () => {
  const lines = captureLogs();
  expect(edgeConfig({})).toBeNull();
  expect(edgeConfig({ CLOUDFLARE_ZONE_ID: config.zoneId, CLOUDFLARE_PURGE_TOKEN: token })).toEqual(config);
  expect(lines).toEqual([]);
  expect(edgeConfig({ CLOUDFLARE_PURGE_TOKEN: token })).toBeNull();
  expect(edgeConfig({ CLOUDFLARE_ZONE_ID: 'not-a-zone', CLOUDFLARE_PURGE_TOKEN: token })).toBeNull();
  expect(lines).toEqual(['edge cache: CLOUDFLARE_ZONE_ID missing or malformed; edge caching stays off']);
  expect(lines.join('\n')).not.toContain(token);
});

test('a purge is one POST of the tags to the zone, with the token as a bearer credential', async () => {
  const fetch = vi.fn<HttpFetch>(async () => answer(200, { success: true, errors: [] }));
  expect(await purgeTags(config, ['pbm-p-1', 'pbm-a-2'], { fetch })).toEqual({ ok: true });
  expect(await purgeTags(config, 'all', { fetch })).toEqual({ ok: true });
  const [[url, init], [, wide]] = fetch.mock.calls as [[string, RequestInit], [string, RequestInit]];
  expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`);
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  expect(JSON.parse(String(init.body))).toEqual({ tags: ['pbm-p-1', 'pbm-a-2'] });
  expect(JSON.parse(String(wide.body))).toEqual({ tags: ['pbm'] });
});

test('a refused, rate-limited or failed purge is reported by status and code only', async () => {
  const refused = async () => answer(403, { success: false, errors: [{ code: 10000, message: `bad token ${token}` }] });
  expect(await purgeTags(config, ['t'], { fetch: refused })).toEqual({ ok: false, why: 'http 403 (cloudflare 10000)', retryAfterMs: null });
  const limited = async () => answer(429, { success: false, errors: [] }, { 'retry-after': '30' });
  expect(await purgeTags(config, ['t'], { fetch: limited })).toEqual({ ok: false, why: 'http 429', retryAfterMs: 30_000 });
  const accepted200ButFailed = async () => answer(200, { success: false });
  expect((await purgeTags(config, ['t'], { fetch: accepted200ButFailed })).ok).toBe(false);
  const broken = async (): Promise<Response> => {
    throw new TypeError(`fetch failed with Bearer ${token}`);
  };
  expect(await purgeTags(config, ['t'], { fetch: broken })).toEqual({ ok: false, why: 'TypeError', retryAfterMs: null });
});

test('a new queue owes the wide purge, so a worker that starts covers what its predecessor never sent', async () => {
  const fetch = vi.fn<HttpFetch>(async () => answer(200, { success: true }));
  const queue = createPurgeQueue();
  expect(queue.owed()).toBe('all');
  queue.add(['pbm-p-1']);
  expect(await queue.flush(config, { fetch })).toBe(true);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toEqual({ tags: ['pbm'] });
  expect(queue.owed()).toEqual([]);
  // Nothing owed: no request.
  expect(await queue.flush(config, { fetch })).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('owed tags go in one request, and more than Cloudflare takes at once become the wide purge', async () => {
  const fetch = vi.fn<HttpFetch>(async () => answer(200, { success: true }));
  const queue = createPurgeQueue({ wide: false });
  queue.add(['a', 'b']);
  queue.add(['b', 'c']);
  expect(queue.owed()).toEqual(['a', 'b', 'c']);
  await queue.flush(config, { fetch });
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toEqual({ tags: ['a', 'b', 'c'] });
  queue.add(Array.from({ length: 101 }, (_, i) => `t${i}`));
  expect(queue.owed()).toBe('all');
  await queue.flush(config, { fetch });
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1].body))).toEqual({ tags: ['pbm'] });
  expect(queue.owed()).toEqual([]);
});

test('a failed purge stays owed and is retried after a backoff, and no log line carries the token', async () => {
  const lines = captureLogs();
  let clock = 1_000_000;
  const now = () => clock;
  let fail = true;
  const fetch = vi.fn<HttpFetch>(async () =>
    fail ? answer(401, { success: false, errors: [{ code: 10001, message: token }] }) : answer(200, { success: true }),
  );
  const queue = createPurgeQueue({ wide: false });
  queue.add(['pbm-c-1']);
  expect(await queue.flush(config, { fetch, now })).toBe(false);
  // Inside the backoff nothing is sent; tags owed meanwhile wait with the first.
  clock += 10_000;
  queue.add(['pbm-c-2']);
  expect(await queue.flush(config, { fetch, now })).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  clock += 10_000;
  expect(await queue.flush(config, { fetch, now })).toBe(false);
  // Failures 3 and 4: only the first, second and fourth are logged.
  clock += 40_000;
  await queue.flush(config, { fetch, now });
  clock += 80_000;
  await queue.flush(config, { fetch, now });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(queue.owed()).toEqual(['pbm-c-1', 'pbm-c-2']);
  fail = false;
  clock += 160_000;
  expect(await queue.flush(config, { fetch, now })).toBe(true);
  expect(JSON.parse(String(fetch.mock.calls[4]?.[1].body))).toEqual({ tags: ['pbm-c-1', 'pbm-c-2'] });
  expect(queue.owed()).toEqual([]);
  expect(lines).toEqual([
    'edge cache: purge failed 1 time in a row (http 401 (cloudflare 10001)); 1 tags still owed, next try in 20 s',
    'edge cache: purge failed 2 times in a row (http 401 (cloudflare 10001)); 2 tags still owed, next try in 40 s',
    'edge cache: purge failed 4 times in a row (http 401 (cloudflare 10001)); 2 tags still owed, next try in 160 s',
    'edge cache: purge succeeded after 4 failed attempts',
  ]);
  expect(lines.join('\n')).not.toContain(token);
});

test("a 429's Retry-After is waited out", async () => {
  captureLogs();
  let clock = 0;
  const now = () => clock;
  const fetch = vi.fn<HttpFetch>(async () => answer(429, { success: false }, { 'retry-after': '120' }));
  const queue = createPurgeQueue({ wide: false });
  queue.add(['x']);
  await queue.flush(config, { fetch, now });
  clock += 119_000;
  await queue.flush(config, { fetch, now });
  expect(fetch).toHaveBeenCalledTimes(1);
  clock += 1_000;
  await queue.flush(config, { fetch, now });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a wide purge is sent once more a minute later, for answers decided before it and stored after it', async () => {
  let clock = 0;
  const now = () => clock;
  const fetch = vi.fn<HttpFetch>(async () => answer(200, { success: true }));
  const bodies = () => fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
  const queue = createPurgeQueue({ wide: false });
  queue.add('all');
  await queue.flush(config, { fetch, now });
  clock += WIDE_ECHO_MS - 1;
  queue.add(['pbm-p-1']);
  await queue.flush(config, { fetch, now });
  clock += 1;
  await queue.flush(config, { fetch, now });
  expect(bodies()).toEqual([{ tags: ['pbm'] }, { tags: ['pbm-p-1'] }, { tags: ['pbm'] }]);
  // The echo itself is not echoed.
  clock += WIDE_ECHO_MS * 2;
  expect(await queue.flush(config, { fetch, now })).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(3);
});
