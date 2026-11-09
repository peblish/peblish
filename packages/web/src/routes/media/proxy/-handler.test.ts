import { proxyUrlBuilder } from '@peblish/core/media/proxy-url';
import { expect, test, vi } from 'vitest';
// The peer gate reads the database; these tests are about the handler, so every peer is approved unless a test says otherwise.
vi.mock('@peblish/core/peers/gate', () => ({ mediaAllowed: async () => true }));

import { PROXY_MAX_AGE_SECONDS, PROXY_RETRY_AFTER_SECONDS, proxyResponse } from './-handler.ts';

const key = Buffer.from('k'.repeat(32));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const remoteUrl = 'https://img.example/a.png';
const [signature, target] = proxyUrlBuilder(key)(remoteUrl).split('/').slice(3) as [string, string];
const image = () => vi.fn(async () => ({ ok: true as const, type: 'image/png' as const, body: png }));

test('a signed URL is fetched and answered with the sniffed type, a private, short cache lifetime and sandboxing headers', async () => {
  const fetchImage = image();
  const { signal } = new AbortController();
  const response = await proxyResponse(signature, target, { key, enabled: true, fetchImage, signal });
  // The request's signal goes along, so a request that gives up while queued is dropped.
  expect(fetchImage).toHaveBeenCalledWith(remoteUrl, signal);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  expect(Object.fromEntries(response.headers)).toEqual({
    'content-type': 'image/png',
    'content-length': String(png.length),
    'cache-control': `private, max-age=${PROXY_MAX_AGE_SECONDS}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'referrer-policy': 'no-referrer',
  });
  expect(PROXY_MAX_AGE_SECONDS).toBeLessThanOrEqual(3600);
});

test('an unsigned, altered or foreign URL is a 404 and fetches nothing', async () => {
  const fetchImage = image();
  const forged = Buffer.from('https://internal.example/').toString('base64url');
  const attempts = [
    ['', target],
    [signature, ''],
    [signature, forged],
    [signature.slice(1), target],
    ['A'.repeat(43), target],
    [signature, target.slice(1)],
  ] as const;
  for (const [s, t] of attempts) {
    const response = await proxyResponse(s, t, { key, enabled: true, fetchImage });
    expect([response.status, response.headers.get('cache-control')], `${s}/${t}`).toEqual([404, 'no-store']);
  }
  expect((await proxyResponse(signature, target, { key: Buffer.from('z'.repeat(32)), enabled: true, fetchImage })).status).toBe(404);
  expect(fetchImage).not.toHaveBeenCalled();
});

test('the kill switch answers 404 for a valid URL without fetching', async () => {
  const fetchImage = image();
  expect((await proxyResponse(signature, target, { key, enabled: false, fetchImage })).status).toBe(404);
  expect(fetchImage).not.toHaveBeenCalled();
});

test('a refused fetch is passed on as its status, uncached, and never redirects to the remote host', async () => {
  for (const status of [403, 413, 415, 502, 504] as const) {
    const response = await proxyResponse(signature, target, {
      key,
      enabled: true,
      fetchImage: async () => ({ ok: false, status, why: 'upstream' }),
    });
    expect([response.status, response.headers.get('cache-control'), response.headers.get('location')]).toEqual([status, 'no-store', null]);
  }
});

test('a busy proxy answers 503 with Retry-After and no caching', async () => {
  const response = await proxyResponse(signature, target, {
    key,
    enabled: true,
    fetchImage: async () => ({ ok: false, status: 503, why: 'busy' }),
  });
  expect([response.status, response.headers.get('retry-after'), response.headers.get('cache-control')]).toEqual([
    503,
    String(PROXY_RETRY_AFTER_SECONDS),
    'no-store',
  ]);
  // Only a busy proxy asks the browser to come back.
  const refused = await proxyResponse(signature, target, {
    key,
    enabled: true,
    fetchImage: async () => ({ ok: false, status: 415, why: 'not_a_raster_image' }),
  });
  expect(refused.headers.get('retry-after')).toBeNull();
});

test('media of a quarantined, purged or blocked peer is a 404 and fetches nothing', async () => {
  const fetchImage = image();
  const asked: string[] = [];
  const response = await proxyResponse(signature, target, {
    key,
    enabled: true,
    fetchImage,
    mediaAllowed: async (host) => {
      asked.push(host);
      return false;
    },
  });
  expect([response.status, response.headers.get('cache-control')]).toEqual([404, 'no-store']);
  expect(asked).toEqual(['img.example']);
  expect(fetchImage).not.toHaveBeenCalled();
});

test('a redirect to a peer whose media is not allowed is a 404, and that host is never contacted', async () => {
  const fetched: string[] = [];
  const hop = (status: number, location?: string) => ({
    status,
    headers: new Headers(location ? { location } : {}),
    body: status === 200 ? new Uint8Array(png) : new Uint8Array(),
    url: '',
  });
  const fetch = vi.fn(async (url: string, init: { maxRedirects: number }) => {
    fetched.push(url);
    // The gate follows redirects itself, so the client is never asked to.
    expect(init.maxRedirects).toBe(0);
    if (url === remoteUrl) return hop(302, 'https://cdn.example/a.png');
    if (url === 'https://cdn.example/a.png') return hop(301, '//quarantined.example/a.png');
    return hop(200);
  });
  const asked: string[] = [];
  const mediaAllowed = async (host: string) => {
    asked.push(host);
    return host !== 'quarantined.example';
  };
  const response = await proxyResponse(signature, target, { key, enabled: true, fetch, mediaAllowed });
  expect([response.status, response.headers.get('cache-control')]).toEqual([404, 'no-store']);
  expect(asked).toEqual(['img.example', 'cdn.example', 'quarantined.example']);
  expect(fetched).toEqual([remoteUrl, 'https://cdn.example/a.png']);

  // An allowed chain is followed to the image.
  fetched.length = 0;
  const allowed = await proxyResponse(signature, target, { key, enabled: true, fetch, mediaAllowed: async () => true });
  expect(allowed.status).toBe(200);
  expect(fetched).toEqual([remoteUrl, 'https://cdn.example/a.png', 'https://quarantined.example/a.png']);
});
