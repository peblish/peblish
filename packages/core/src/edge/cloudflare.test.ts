import { afterEach, expect, test, vi } from 'vitest';
import { purgeTags, type HttpFetch } from './cloudflare.ts';
import { edgeConfig } from './config.ts';

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
  expect(await purgeTags(config, ['t'], { fetch: refused })).toEqual({
    ok: false,
    why: 'http 403 (cloudflare 10000)',
    retryAfterMs: null,
    refused: true,
  });
  const limited = async () => answer(429, { success: false, errors: [] }, { 'retry-after': '30' });
  expect(await purgeTags(config, ['t'], { fetch: limited })).toEqual({ ok: false, why: 'http 429', retryAfterMs: 30_000, refused: false });
  const accepted200ButFailed = async () => answer(200, { success: false });
  expect((await purgeTags(config, ['t'], { fetch: accepted200ButFailed })).ok).toBe(false);
  const broken = async (): Promise<Response> => {
    throw new TypeError(`fetch failed with Bearer ${token}`);
  };
  expect(await purgeTags(config, ['t'], { fetch: broken })).toEqual({ ok: false, why: 'TypeError', retryAfterMs: null, refused: false });
});
