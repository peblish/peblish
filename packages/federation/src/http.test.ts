import { beforeEach, describe, expect, test, vi } from 'vitest';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor } from '@peblish/core/testing/seed';
import { seedPost } from '@peblish/core/testing/seed-az';
import { rsaKeys, seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { lookupBudgets, resetKeyFetchBudget, takeKeyLookup } from './inbound/throttle.ts';
import { signDelivery } from './signing/sign.ts';
import { handleFederationRequest, isFederationRequest, prefersActivityJson, type FederationContext } from './http.ts';

const request = (path: string, accept?: string) => new Request(`https://feddit.test${path}`, { headers: accept ? { accept } : {} });
const activity = 'application/activity+json';
const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

describe('federation routing', () => {
  test.each([
    '/ap/posts/1',
    '/.well-known/webfinger',
    '/.well-known/nodeinfo',
    '/nodeinfo/2.1',
    '/inbox',
    '/outbox',
    '/u/andrew/inbox',
    '/c/announcements/outbox',
    '/u/feddit-admin/followers',
    '/c/announcements/featured',
    '/c/announcements/moderators',
  ])('%s always goes to federation', (path) => {
    expect(isFederationRequest(request(path, browser))).toBe(true);
  });

  test.each(['/', '/u/andrew', '/c/announcements'])('%s goes to federation only when ActivityPub is asked for', (path) => {
    expect(isFederationRequest(request(path, activity))).toBe(true);
    expect(isFederationRequest(request(path, 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"'))).toBe(true);
    expect(isFederationRequest(request(path, browser))).toBe(false);
    expect(isFederationRequest(request(path))).toBe(false);
  });

  test.each(['/healthz', '/u/andrew/posts', '/c', '/apx', '/.well-known/host-meta'])('%s stays with the UI', (path) => {
    expect(isFederationRequest(request(path, activity))).toBe(false);
  });

  test('Accept quality values decide', () => {
    expect(prefersActivityJson(`${activity};q=0`)).toBe(false);
    expect(prefersActivityJson(`text/html, ${activity};q=0.5`)).toBe(false);
    expect(prefersActivityJson(`text/html;q=0.5, ${activity}`)).toBe(true);
    expect(prefersActivityJson('*/*')).toBe(false);
  });
});

describe('answering federation requests', () => {
  const origin = 'https://fed-a.test';
  const ask = (path: string, init: RequestInit = {}) => handleFederationRequest(new Request(`${origin}${path}`, init));

  beforeEach(async () => {
    await truncateAll();
    const { instance } = await seedLocalInstance('fed-a.test');
    const alice = await seedActor(instance, 'Person', 'alice');
    await seedSigningKey(alice);
    const news = await seedActor(instance, 'Group', 'news', { followersUrl: `${origin}/ap/c.news/followers` });
    await seedPost(instance, news, alice);
  });

  test.each(['/', '/u/alice', '/c/news', '/ap/u.alice', '/ap/c.news/followers'])(
    '%s answers ActivityPub JSON with a cache lifetime',
    async (path) => {
      const response = (await ask(path, { headers: { accept: activity } }))!;
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/activity+json; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('public, max-age=60');
      expect(await response.json()).toHaveProperty('type');
    },
  );

  test('a page path with no actor behind it is declined, so the UI renders its own not-found page; a path of ours is a 404', async () => {
    expect(await ask('/u/nobody', { headers: { accept: activity } })).toBeNull();
    expect(await ask('/c/nobody', { headers: { accept: activity } })).toBeNull();
    expect((await ask('/ap/u.nobody'))?.status).toBe(404);
    expect((await ask('/ap/post/0190b7a8-0000-7000-8000-000000000001'))?.status).toBe(404);
    expect((await ask('/nodeinfo/9.9'))?.status).toBe(404);
    expect((await ask('/.well-known/webfinger?resource=acct:nobody@fed-a.test'))?.status).toBe(404);
  });

  test('WebFinger and NodeInfo answer on their well-known paths', async () => {
    const webfinger = (await ask('/.well-known/webfinger?resource=acct:alice@fed-a.test'))!;
    expect(webfinger.headers.get('content-type')).toContain('application/jrd+json');
    expect(((await webfinger.json()) as { subject: string }).subject).toBe('acct:alice@fed-a.test');
    expect(((await (await ask('/.well-known/nodeinfo'))!.json()) as { links: unknown[] }).links).toHaveLength(2);
    expect(((await (await ask('/nodeinfo/2.1'))!.json()) as { software: { name: string } }).software.name).toBe('peblish');
  });

  test('every inbox takes a POST, and an unsigned one is answered 401', async () => {
    for (const path of ['/inbox', '/ap/u.alice/inbox', '/ap/c.news/inbox', '/u/alice/inbox', '/c/news/inbox']) {
      const response = (await ask(path, { method: 'POST', body: '{}', headers: { 'content-type': activity } }))!;
      expect(response.status, path).toBe(401);
    }
  });

  test('an inbox POST is counted by the address the caller resolved, a forwarded one behind Traefik included', async () => {
    const inbox = `${origin}/inbox`;
    const body = '{}';
    const stranger = { keyId: 'https://unknown.test/u/someone#main-key', privateKeyPem: rsaKeys().privateKeyPem };
    const post = (context: FederationContext, extra: Record<string, string> = {}) => {
      const headers = signDelivery(stranger, inbox, body);
      for (const [name, value] of Object.entries(extra)) headers.set(name, value);
      return handleFederationRequest(new Request(inbox, { method: 'POST', body, headers }), context);
    };
    const spend = (address: string) => {
      for (let n = 0; n < lookupBudgets.discovery.perAddress; n++) takeKeyLookup('discovery', { address, host: 'unknown.test' });
    };
    resetKeyFetchBudget();

    // A spent address is refused before anything is fetched, so the stranger's key is never looked for.
    spend('203.0.113.1');
    expect((await post({ peer: '203.0.113.1' }))?.status).toBe(429);
    vi.stubEnv('PEBLISH_TRUSTED_PROXY', 'traefik');
    try {
      expect((await post({ peer: '10.0.0.2' }, { 'x-forwarded-for': '10.9.9.9, 203.0.113.1' }))?.status).toBe(429);
    } finally {
      vi.unstubAllEnvs();
    }
    resetKeyFetchBudget();
  });

  test('a GET of an inbox and a write to a document are 405, and never 410 or 418', async () => {
    const inbox = (await ask('/inbox'))!;
    expect(inbox.status).toBe(405);
    expect(inbox.headers.get('allow')).toBe('POST');
    const write = (await ask('/ap/u.alice', { method: 'POST', body: '{}' }))!;
    expect(write.status).toBe(405);
    expect(write.headers.get('allow')).toBe('GET, HEAD');
  });

  test('a write to a page path is left to the UI', async () => {
    expect(await ask('/u/alice', { method: 'POST', body: '{}', headers: { accept: activity } })).toBeNull();
  });

  test('HEAD has the headers of the GET and no body', async () => {
    const response = (await ask('/ap/u.alice', { method: 'HEAD' }))!;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/activity+json');
    expect(await response.text()).toBe('');
  });

  test('a failure behind the scenes is 503 with Retry-After, not a 500', async () => {
    // No local instance row: the origin cannot be read, as when the server starts before migrate.
    await truncateAll();
    delete (globalThis as { __peblishOrigin?: unknown }).__peblishOrigin;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = (await ask('/ap/u.alice'))!;
    log.mockRestore();
    expect(response.status).toBe(503);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
