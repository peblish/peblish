import { proxyUrlBuilder } from '@peblish/core/media/proxy-url';
import { EDGE_MAX_AGE_SECONDS } from '@peblish/core/edge/config';
import { describe, expect, test, vi } from 'vitest';
// The peer gate reads the database; these tests are about the handler, so every peer is approved unless a test says otherwise.
vi.mock('@peblish/core/peers/gate', () => ({ mediaAllowed: async () => true, supplierMediaAllowed: async () => true }));

import { PROXY_MAX_AGE_SECONDS, PROXY_RETRY_AFTER_SECONDS, proxyResponse } from './-handler.ts';

const key = Buffer.from('k'.repeat(32));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const remoteUrl = 'https://img.example/a.png';
const [signature, target] = proxyUrlBuilder(key)(remoteUrl).split('/').slice(3) as [string, string];
/** Every post, comment and actor is shown unless a test says otherwise. */
const contentShown = async () => true;
const image = () => vi.fn(async () => ({ ok: true as const, type: 'image/png' as const, body: png }));

test('a signed URL is fetched and answered with the sniffed type, a private, short cache lifetime and sandboxing headers', async () => {
  const fetchImage = image();
  const { signal } = new AbortController();
  const response = await proxyResponse(signature, target, { key, enabled: true, contentShown, fetchImage, signal });
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
    const response = await proxyResponse(s, t, { key, enabled: true, contentShown, fetchImage });
    expect([response.status, response.headers.get('cache-control')], `${s}/${t}`).toEqual([404, 'no-store']);
  }
  expect(
    (await proxyResponse(signature, target, { key: Buffer.from('z'.repeat(32)), enabled: true, contentShown, fetchImage })).status,
  ).toBe(404);
  expect(fetchImage).not.toHaveBeenCalled();
});

test('the kill switch answers 404 for a valid URL without fetching', async () => {
  const fetchImage = image();
  expect((await proxyResponse(signature, target, { key, enabled: false, contentShown, fetchImage })).status).toBe(404);
  expect(fetchImage).not.toHaveBeenCalled();
});

test('a refused fetch is passed on as its status, uncached, and never redirects to the remote host', async () => {
  for (const status of [403, 413, 415, 502, 504] as const) {
    const response = await proxyResponse(signature, target, {
      key,
      enabled: true,
      contentShown,
      fetchImage: async () => ({ ok: false, status, why: 'upstream' }),
    });
    expect([response.status, response.headers.get('cache-control'), response.headers.get('location')]).toEqual([status, 'no-store', null]);
  }
});

test('a busy proxy answers 503 with Retry-After and no caching', async () => {
  const response = await proxyResponse(signature, target, {
    key,
    enabled: true,
    contentShown,
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
    contentShown,
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
    contentShown,
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
  const response = await proxyResponse(signature, target, { key, enabled: true, contentShown, fetch, mediaAllowed });
  expect([response.status, response.headers.get('cache-control')]).toEqual([404, 'no-store']);
  expect(asked).toEqual(['img.example', 'cdn.example', 'quarantined.example']);
  expect(fetched).toEqual([remoteUrl, 'https://cdn.example/a.png']);

  // An allowed chain is followed to the image.
  fetched.length = 0;
  const allowed = await proxyResponse(signature, target, { key, enabled: true, contentShown, fetch, mediaAllowed: async () => true });
  expect(allowed.status).toBe(200);
  expect(fetched).toEqual([remoteUrl, 'https://cdn.example/a.png', 'https://quarantined.example/a.png']);
});

test('a URL signed for content is a 404 once that content is not shown to the viewer, and fetches nothing', async () => {
  const post = { kind: 'post', id: '0195f0a0-0000-7000-8000-000000000001', supplier: null } as const;
  const [bound, boundTarget] = proxyUrlBuilder(key)(remoteUrl, post).split('/').slice(3) as [string, string];
  const fetchImage = image();
  const asked: unknown[] = [];
  const hidden = async (content: unknown) => {
    asked.push(content);
    return false;
  };
  const response = await proxyResponse(bound, boundTarget, { key, enabled: true, contentShown: hidden, fetchImage });
  expect([response.status, response.headers.get('cache-control')]).toEqual([404, 'no-store']);
  expect(asked).toEqual([post]);
  expect(fetchImage).not.toHaveBeenCalled();
  // While it is shown, the same URL is fetched.
  expect((await proxyResponse(bound, boundTarget, { key, enabled: true, contentShown, fetchImage })).status).toBe(200);
});

test('a URL signed for no content expires: a 404 once its hour is over, without asking about content', async () => {
  const issued = Date.UTC(2026, 10, 10, 9, 30);
  const [unbound, unboundTarget] = proxyUrlBuilder(
    key,
    () => issued,
  )(remoteUrl)
    .split('/')
    .slice(3) as [string, string];
  const fetchImage = image();
  const asked = vi.fn(async () => true);
  const at = (now: number) => proxyResponse(unbound, unboundTarget, { key, enabled: true, contentShown: asked, fetchImage, now });
  expect((await at(issued + 89 * 60_000)).status).toBe(200);
  const expired = await at(issued + 90 * 60_000);
  expect([expired.status, expired.headers.get('cache-control')]).toEqual([404, 'no-store']);
  expect(fetchImage).toHaveBeenCalledTimes(1);
  expect(asked).not.toHaveBeenCalled();
});

test('an image of content a quarantined, purged or blocked peer supplied is a 404 wherever it is hosted, and fetches nothing', async () => {
  // The image sits on a host no peer owns (which mediaAllowed lets through); the post came from piefed.test.
  const post = { kind: 'post', id: '0195f0a0-0000-7000-8000-000000000002', supplier: 'piefed.test' } as const;
  const [bound, boundTarget] = proxyUrlBuilder(key)(remoteUrl, post).split('/').slice(3) as [string, string];
  const fetchImage = image();
  const asked: string[] = [];
  const supplierAllowed = async (host: string) => {
    asked.push(host);
    return host !== 'piefed.test';
  };
  const deps = { key, enabled: true, contentShown, fetchImage, mediaAllowed: async () => true, supplierAllowed };
  const response = await proxyResponse(bound, boundTarget, deps);
  expect([response.status, response.headers.get('cache-control')]).toEqual([404, 'no-store']);
  expect(asked).toEqual(['piefed.test']);
  expect(fetchImage).not.toHaveBeenCalled();
  // This instance's own content names no supplier, so only the image's host is asked about.
  const own = proxyUrlBuilder(key)(remoteUrl, { ...post, supplier: null })
    .split('/')
    .slice(3) as [string, string];
  expect((await proxyResponse(...own, deps)).status).toBe(200);
  expect(asked).toEqual(['piefed.test']);
});

test('a URL whose target is itself one of our proxy paths is a 404 and fetches nothing (CN1)', async () => {
  const fetchImage = image();
  const inner = `https://feddit.example${proxyUrlBuilder(key)(remoteUrl, { kind: 'post', id: '0195f0a0-0000-7000-8000-000000000003', supplier: null })}`;
  const [outer, outerTarget] = proxyUrlBuilder(key)(inner).split('/').slice(3) as [string, string];
  const response = await proxyResponse(outer, outerTarget, { key, enabled: true, contentShown, fetchImage });
  expect([response.status, response.headers.get('cache-control')]).toEqual([404, 'no-store']);
  expect(fetchImage).not.toHaveBeenCalled();
  // Another instance's proxy path is just a remote image.
  const theirs = `https://other.example${proxyUrlBuilder(Buffer.from('o'.repeat(32)))(remoteUrl)}`;
  const [other, otherTarget] = proxyUrlBuilder(key)(theirs).split('/').slice(3) as [string, string];
  expect((await proxyResponse(other, otherTarget, { key, enabled: true, contentShown, fetchImage })).status).toBe(200);
});

describe('edge caching', () => {
  const post = { kind: 'post', id: '0195f0a0-0000-7000-8000-000000000010', supplier: 'lemmy.test' } as const;
  const [bound, boundTarget] = proxyUrlBuilder(key)(remoteUrl, post).split('/').slice(3) as [string, string];
  const tags = ['pbm', `pbm-p-${post.id}`];
  const viewerNeverRead = vi.fn(async () => {
    throw new Error('a public answer never reads the viewer');
  });
  const base = { key, enabled: true, mediaAllowed: async () => true, supplierAllowed: async () => true };

  test('content a signed-out visitor is shown is answered public, tagged for purging, without reading the viewer', async () => {
    const publicTags = vi.fn(async () => tags);
    const response = await proxyResponse(bound, boundTarget, {
      ...base,
      contentShown: viewerNeverRead,
      fetchImage: image(),
      edge: { publicTags },
    });
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'image/png',
      'content-length': String(png.length),
      'cache-control': `public, max-age=${PROXY_MAX_AGE_SECONDS}, s-maxage=${EDGE_MAX_AGE_SECONDS}`,
      'cache-tag': tags.join(','),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
    });
    expect(publicTags).toHaveBeenCalledWith(post);
    expect(viewerNeverRead).not.toHaveBeenCalled();
    expect(PROXY_MAX_AGE_SECONDS).toBe(600);
  });

  test('content shown only to some viewers is answered exactly as without an edge cache', async () => {
    const shownTo = vi.fn(async () => true);
    const response = await proxyResponse(bound, boundTarget, {
      ...base,
      contentShown: shownTo,
      fetchImage: image(),
      edge: { publicTags: async () => null },
    });
    expect([response.headers.get('cache-control'), response.headers.get('cache-tag')]).toEqual([
      `private, max-age=${PROXY_MAX_AGE_SECONDS}`,
      null,
    ]);
    expect(shownTo).toHaveBeenCalledWith(post);
    const hidden = await proxyResponse(bound, boundTarget, {
      ...base,
      contentShown: async () => false,
      fetchImage: image(),
      edge: { publicTags: async () => null },
    });
    expect([hidden.status, hidden.headers.get('cache-control')]).toEqual([404, 'no-store']);
  });

  test('a URL bound to no content stays private and asks nothing about the public', async () => {
    const publicTags = vi.fn(async () => tags);
    const response = await proxyResponse(signature, target, { ...base, contentShown, fetchImage: image(), edge: { publicTags } });
    expect(response.headers.get('cache-control')).toBe(`private, max-age=${PROXY_MAX_AGE_SECONDS}`);
    expect(publicTags).not.toHaveBeenCalled();
  });

  test('without the purge configuration the same content is private', async () => {
    const response = await proxyResponse(bound, boundTarget, { ...base, contentShown, fetchImage: image(), edge: null });
    expect([response.headers.get('cache-control'), response.headers.get('cache-tag')]).toEqual([
      `private, max-age=${PROXY_MAX_AGE_SECONDS}`,
      null,
    ]);
  });

  test('content taken down while its image was fetched is not answered public', async () => {
    const answers = [tags, null];
    const edge = { publicTags: async () => answers.shift() ?? null };
    // Still shown to this viewer (a moderator of a sensitive post, say): private.
    const kept = await proxyResponse(bound, boundTarget, { ...base, contentShown: async () => true, fetchImage: image(), edge });
    expect([kept.status, kept.headers.get('cache-control')]).toEqual([200, `private, max-age=${PROXY_MAX_AGE_SECONDS}`]);
    answers.push(tags, null);
    const gone = await proxyResponse(bound, boundTarget, { ...base, contentShown: async () => false, fetchImage: image(), edge });
    expect([gone.status, gone.headers.get('cache-control')]).toEqual([404, 'no-store']);
  });

  test('refusals and errors stay uncached, and a denied supplier or host is never asked about', async () => {
    const publicTags = vi.fn(async () => tags);
    const edge = { publicTags };
    for (const status of [403, 413, 415, 502, 503, 504] as const) {
      const response = await proxyResponse(bound, boundTarget, {
        ...base,
        contentShown,
        edge,
        fetchImage: async () => ({ ok: false, status, why: 'upstream' }),
      });
      expect([response.status, response.headers.get('cache-control'), response.headers.get('cache-tag')]).toEqual([
        status,
        'no-store',
        null,
      ]);
    }
    publicTags.mockClear();
    const supplier = await proxyResponse(bound, boundTarget, {
      ...base,
      contentShown,
      edge,
      fetchImage: image(),
      supplierAllowed: async () => false,
    });
    expect([supplier.status, supplier.headers.get('cache-control')]).toEqual([404, 'no-store']);
    expect(publicTags).not.toHaveBeenCalled();
    const host = await proxyResponse(bound, boundTarget, {
      ...base,
      contentShown,
      edge,
      fetchImage: image(),
      mediaAllowed: async () => false,
    });
    expect([host.status, host.headers.get('cache-control')]).toEqual([404, 'no-store']);
    const off = await proxyResponse(bound, boundTarget, { ...base, enabled: false, contentShown, edge, fetchImage: image() });
    expect([off.status, off.headers.get('cache-control')]).toEqual([404, 'no-store']);
  });
});
