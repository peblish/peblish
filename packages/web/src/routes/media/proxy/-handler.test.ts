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
