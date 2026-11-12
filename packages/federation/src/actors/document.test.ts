import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { truncateAll } from '@peblish/core/testing/db';
import { seedLocalInstance, seedSigningKey, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { fetchActivity, FetchFailure } from './document.ts';

const start = 'https://peer.test/a';
const hop = (n: number) => `https://peer.test/hop${n}`;
const doc = { type: 'Note', id: 'https://peer.test/final' };
/** a redirects to hop1, hop1 to hop2, and so on, `count` times, then the document. */
const chain = (count: number) =>
  stubFetch({
    [start]: count === 0 ? { body: doc } : { status: 302, location: hop(1) },
    ...Object.fromEntries(
      Array.from({ length: count }, (_, i) => [hop(i + 1), i + 1 === count ? { body: doc } : { status: 308, location: hop(i + 2) }]),
    ),
  });

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

describe('fetchActivity', () => {
  test('follows no redirect unless the caller allows some', async () => {
    const { fetch, requests } = chain(1);
    const error = await fetchActivity(start, fetch).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FetchFailure);
    expect(error).toMatchObject({ reason: 'status', status: 302 });
    expect(requests.map((request) => request.url)).toEqual([start]);
  });

  test('reports the document, where it came from and how many redirects led there', async () => {
    const direct = chain(0);
    expect(await fetchActivity(start, direct.fetch)).toEqual({ json: doc, url: start, hops: 0 });
    const moved = chain(2);
    expect(await fetchActivity(start, moved.fetch, { maxRedirects: 3 })).toEqual({ json: doc, url: hop(2), hops: 2 });
    expect(moved.requests.map((request) => request.url)).toEqual([start, hop(1), hop(2)]);
    // Every hop is its own request with safeFetch's own redirect following switched off.
    expect(moved.requests.every((request) => (request.init as { maxRedirects: number }).maxRedirects === 0)).toBe(true);
  });

  test('stops at the redirect limit, and a redirect to something that is not a URL is a failure', async () => {
    const long = chain(4);
    expect(await fetchActivity(start, long.fetch, { maxRedirects: 3 }).catch((caught: unknown) => caught)).toMatchObject({
      reason: 'status',
      status: 308,
    });
    expect(long.requests).toHaveLength(4);
    const bad = stubFetch({ [start]: { status: 301, location: 'http://[bad' } });
    expect(await fetchActivity(start, bad.fetch, { maxRedirects: 3 }).catch((caught: unknown) => caught)).toMatchObject({
      reason: 'status',
    });
  });

  test('only the first request is signed; a redirected hop goes out without the signature', async () => {
    const [instanceActor] = await db().select().from(actors).where(eq(actors.kind, 'Application'));
    await seedSigningKey(instanceActor!);
    const { fetch, requests } = chain(1);
    await fetchActivity(start, fetch, { maxRedirects: 3 });
    expect(requests[0]?.headers.get('signature')).toContain('keyId=');
    expect(requests[1]?.headers.get('signature')).toBeNull();
    expect(requests[1]?.headers.get('date')).toBeNull();
  });
});

describe('a fetch the instance key cannot sign', () => {
  test('goes out unsigned, and under a request the warning names no URL; the worker still names it', async () => {
    const { requestScope } = await import('@peblish/core/log-scope');
    const { vi } = await import('vitest');
    const { actorKeys } = await import('@peblish/core/db/tables/actors');
    const { writer } = await import('@peblish/core/db/write');
    const { and } = await import('drizzle-orm');
    const [instance] = await db()
      .select()
      .from(actors)
      .where(and(eq(actors.local, true), eq(actors.kind, 'Application')));
    if (!instance) throw new Error('no instance actor');
    await writer()
      .insert(actorKeys)
      .values({
        actorId: instance.id,
        keyId: `${instance.apId}#main-key`,
        algorithm: 'rsa',
        publicKeyPem: 'broken',
        privateKeyPem: 'broken',
      });
    const typed = 'https://typed-MARKER.test/a';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { fetch } = stubFetch({ [typed]: { body: doc } });
      await requestScope.run('GET /resolve/', () => fetchActivity(typed, fetch));
      const underRequest = warn.mock.calls.flat().map(String);
      expect(underRequest.length).toBe(1);
      expect(underRequest[0]).not.toContain('MARKER');
      expect(underRequest[0]).toMatch(/^could not sign a fetch: \S/);
      warn.mockClear();
      await fetchActivity(typed, fetch);
      expect(String(warn.mock.calls[0]?.[0])).toContain(typed);
    } finally {
      warn.mockRestore();
    }
  });
});
