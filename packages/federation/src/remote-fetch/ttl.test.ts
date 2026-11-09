import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actorKeys } from '@peblish/core/db/tables/actors';
import { truncateAll } from '@peblish/core/testing/db';
import { actorDocument, nodeInfoRoutes, rsaKeys, seedLocalInstance, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { resolveRemoteActor } from '../actors/resolve.ts';
import { refreshInstanceSoftware } from '../nodeinfo/client.ts';
import { signDelivery } from '../signing/sign.ts';
import { forgetKeyRefreshes, verifyInboundSignature } from '../signing/inbound.ts';
import { remoteTtls } from './ttl.ts';

const hour = 60 * 60 * 1000;
const minute = 60 * 1000;
const t0 = new Date('2026-11-09T09:00:00Z');
const inbox = 'https://rem.test/inbox';
const body = JSON.stringify({ type: 'Like', id: 'https://lemmy.test/activities/1' });
const document = (publicKeyPem: string) => actorDocument('lemmy.test', 'sender', { publicKeyPem });
const sender = document('').id;
const keyId = `${sender}#main-key`;
const actorFetches = (requests: { url: string }[]) => requests.filter((request) => request.url === sender).length;
const at = (ms: number) => vi.setSystemTime(new Date(t0.getTime() + ms));

// Only Date is faked: the database driver keeps its timers.
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: t0 });
  await truncateAll();
  await seedLocalInstance('rem.test');
  forgetKeyRefreshes();
});
afterEach(() => vi.useRealTimers());

describe('the cache figures', () => {
  test('are a day for a document, a minute for a key, a day for NodeInfo and half a day for moderators', () => {
    expect(remoteTtls).toMatchObject({
      actorMs: 24 * hour,
      keyRefetchMs: minute,
      nodeInfoMs: 24 * hour,
      nodeInfoRetryMs: 10 * minute,
      moderatorsMs: 12 * hour,
    });
  });
});

describe('refreshing on use', () => {
  test('a stored actor is used as it is for a day, then fetched again the next time it is needed', async () => {
    const keys = rsaKeys();
    const peer = stubFetch({ [sender]: { body: document(keys.publicKeyPem) }, ...nodeInfoRoutes('lemmy.test', 'lemmy') });
    await resolveRemoteActor(sender, { fetch: peer.fetch });
    expect(actorFetches(peer.requests)).toBe(1);

    at(remoteTtls.actorMs - minute);
    await resolveRemoteActor(sender, { fetch: peer.fetch });
    expect(actorFetches(peer.requests)).toBe(1);

    at(remoteTtls.actorMs + minute);
    await resolveRemoteActor(sender, { fetch: peer.fetch });
    expect(actorFetches(peer.requests)).toBe(2);
    // The refresh restarts the day.
    at(remoteTtls.actorMs + 2 * minute);
    await resolveRemoteActor(sender, { fetch: peer.fetch });
    expect(actorFetches(peer.requests)).toBe(2);
  });

  test('a peer that is down at refresh time does not take the copy away', async () => {
    const peer = stubFetch({ [sender]: { body: document(rsaKeys().publicKeyPem) }, ...nodeInfoRoutes('lemmy.test', 'lemmy') });
    await resolveRemoteActor(sender, { fetch: peer.fetch });
    at(remoteTtls.actorMs + minute);
    const down = stubFetch({ [sender]: { status: 503 } });
    expect(await resolveRemoteActor(sender, { fetch: down.fetch })).toMatchObject({ apId: sender, deleted: false });
  });

  test('NodeInfo is read again after a day', async () => {
    const origin = 'https://lemmy.test';
    const peer = stubFetch({ [sender]: { body: document(rsaKeys().publicKeyPem) }, ...nodeInfoRoutes('lemmy.test', 'lemmy') });
    const reads = () => peer.requests.filter((request) => request.url.endsWith('/.well-known/nodeinfo')).length;
    // The first actor fetch reads it.
    await resolveRemoteActor(sender, { fetch: peer.fetch });
    expect(reads()).toBe(1);
    await refreshInstanceSoftware(origin, { fetch: peer.fetch, now: t0.getTime() + remoteTtls.nodeInfoMs - minute });
    expect(reads()).toBe(1);
    await refreshInstanceSoftware(origin, { fetch: peer.fetch, now: t0.getTime() + remoteTtls.nodeInfoMs + minute });
    expect(reads()).toBe(2);
  });
});

describe('a key that stops verifying', () => {
  async function signedBy(privateKeyPem: string) {
    return new Request(inbox, { method: 'POST', headers: signDelivery({ keyId, privateKeyPem }, inbox, body), body });
  }
  const bytes = new TextEncoder().encode(body);

  test('is looked for once in the actor’s current document, and not again until the key figure has passed', async () => {
    const old = rsaKeys();
    const fresh = rsaKeys();
    await resolveRemoteActor(sender, {
      fetch: stubFetch({ [sender]: { body: document(old.publicKeyPem) }, ...nodeInfoRoutes('lemmy.test', 'lemmy') }).fetch,
    });

    // The actor rotated its key. A minute and a bit later a request signed with the new one arrives.
    at(remoteTtls.keyRefetchMs + 5_000);
    const rotated = stubFetch({ [sender]: { body: document(fresh.publicKeyPem) }, ...nodeInfoRoutes('lemmy.test', 'lemmy') });
    expect(await verifyInboundSignature(await signedBy(fresh.privateKeyPem), bytes, { fetch: rotated.fetch })).toMatchObject({ ok: true });
    expect(actorFetches(rotated.requests)).toBe(1);
    expect(await db().select().from(actorKeys).where(eq(actorKeys.keyId, keyId))).toMatchObject([{ publicKeyPem: fresh.publicKeyPem }]);

    // A signature nobody can verify is not a reason to ask again straight away...
    const forged = await signedBy(rsaKeys().privateKeyPem);
    at(remoteTtls.keyRefetchMs + 10_000);
    expect(await verifyInboundSignature(forged.clone(), bytes, { fetch: rotated.fetch })).toEqual({ ok: false, reason: 'invalid' });
    expect(actorFetches(rotated.requests)).toBe(1);
    // ...but is, a minute after the last time.
    at(2 * remoteTtls.keyRefetchMs + 10_000);
    expect(await verifyInboundSignature(await signedBy(rsaKeys().privateKeyPem), bytes, { fetch: rotated.fetch })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(actorFetches(rotated.requests)).toBe(2);
  });
});
