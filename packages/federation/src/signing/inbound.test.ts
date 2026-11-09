import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { writer } from '@peblish/core/db/write';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { truncateAll } from '@peblish/core/testing/db';
import { actorDocument, rsaKeys, seedLocalInstance, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { resolveRemoteActor } from '../actors/resolve.ts';
import { signDelivery } from './sign.ts';
import { forgetKeyRefreshes, keyRefetchAfterMs, verifyInboundSignature } from './inbound.ts';

const inbox = 'https://fed-a.test/inbox';
const body = JSON.stringify({ type: 'Like', id: 'https://lemmy.test/activities/1' });
const sender = actorDocument('lemmy.test', 'sender', { publicKeyPem: '' });
const keyId = `${sender.id}#main-key`;

/** A POST to our inbox signed with `privateKeyPem` as the sender's key. */
async function signed(privateKeyPem: string, content = body) {
  const headers = signDelivery({ keyId, privateKeyPem }, inbox, content);
  return new Request(inbox, { method: 'POST', headers, body: content });
}
const bytes = (text = body) => new TextEncoder().encode(text);
const document = (publicKeyPem: string) => actorDocument('lemmy.test', 'sender', { publicKeyPem });

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
  forgetKeyRefreshes();
});

describe('verifying an inbox POST', () => {
  test('a stored actor’s signature verifies, and names the actor that signed', async () => {
    const keys = rsaKeys();
    const { fetch, requests } = stubFetch({ [sender.id]: { body: document(keys.publicKeyPem) } });
    await resolveRemoteActor(sender.id, { fetch });
    const before = requests.length;
    expect(await verifyInboundSignature(await signed(keys.privateKeyPem), bytes(), { fetch })).toEqual({
      ok: true,
      keyId,
      ownerApId: sender.id,
    });
    expect(requests).toHaveLength(before);
  });

  test('a key we do not hold has its actor fetched once, stored, and then verified', async () => {
    const keys = rsaKeys();
    const { fetch, requests } = stubFetch({ [sender.id]: { body: document(keys.publicKeyPem) } });
    expect(await verifyInboundSignature(await signed(keys.privateKeyPem), bytes(), { fetch })).toMatchObject({
      ok: true,
      ownerApId: sender.id,
    });
    expect(requests.map((request) => request.url).filter((url) => url === sender.id)).toHaveLength(1);
    expect(await db().select().from(actorKeys).where(eq(actorKeys.keyId, keyId))).toHaveLength(1);
  });

  test('a rotated key is picked up from the actor’s current document, but only once a minute', async () => {
    const old = rsaKeys();
    const fresh = rsaKeys();
    const first = stubFetch({ [sender.id]: { body: document(old.publicKeyPem) } });
    await resolveRemoteActor(sender.id, { fetch: first.fetch });

    const rotated = stubFetch({ [sender.id]: { body: document(fresh.publicKeyPem) } });
    // Fetched a moment ago: the new key is not looked for yet.
    expect(await verifyInboundSignature(await signed(fresh.privateKeyPem), bytes(), { fetch: rotated.fetch })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(rotated.requests).toHaveLength(0);

    await writer()
      .update(actors)
      .set({ fetchedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(actors.apId, sender.id));
    expect(await verifyInboundSignature(await signed(fresh.privateKeyPem), bytes(), { fetch: rotated.fetch })).toMatchObject({ ok: true });
    expect(rotated.requests.filter((request) => request.url === sender.id)).toHaveLength(1);
  });

  test('a key refresh answered by a Tombstone for the actor deletes our copy and verifies nothing', async () => {
    const old = rsaKeys();
    const first = stubFetch({ [sender.id]: { body: document(old.publicKeyPem) } });
    const held = await resolveRemoteActor(sender.id, { fetch: first.fetch });
    await writer()
      .update(actors)
      .set({ fetchedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(actors.id, held.id));

    const gone = stubFetch({ [sender.id]: { body: { type: 'Tombstone', id: sender.id } } });
    expect(await verifyInboundSignature(await signed(rsaKeys().privateKeyPem), bytes(), { fetch: gone.fetch })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const [row] = await db().select({ deletedAt: actors.deletedAt }).from(actors).where(eq(actors.id, held.id));
    expect(row?.deletedAt).not.toBeNull();
  });

  test('a key the actor drops from its document stops verifying once the actor is refreshed', async () => {
    const keys = rsaKeys();
    const first = stubFetch({ [sender.id]: { body: document(keys.publicKeyPem) } });
    await resolveRemoteActor(sender.id, { fetch: first.fetch });
    expect(await verifyInboundSignature(await signed(keys.privateKeyPem), bytes(), { fetch: first.fetch })).toMatchObject({ ok: true });

    const { publicKey: _dropped, ...withoutKey } = document(keys.publicKeyPem);
    const refreshed = stubFetch({ [sender.id]: { body: withoutKey } });
    await resolveRemoteActor(sender.id, { fetch: refreshed.fetch, refresh: true });
    expect(await db().select().from(actorKeys)).toEqual([]);
    expect(await verifyInboundSignature(await signed(keys.privateKeyPem), bytes(), { fetch: refreshed.fetch })).toEqual({
      ok: false,
      reason: 'key_unknown',
    });
  });

  test('a stale actor whose endpoint is down is fetched once a minute, however many bad signatures arrive', async () => {
    const keys = rsaKeys();
    const first = stubFetch({ [sender.id]: { body: document(keys.publicKeyPem) } });
    await resolveRemoteActor(sender.id, { fetch: first.fetch });
    await writer()
      .update(actors)
      .set({ fetchedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(actors.apId, sender.id));
    forgetKeyRefreshes();

    const down = stubFetch({ [sender.id]: { status: 503 } });
    const forged = await signed(rsaKeys().privateKeyPem);
    const now = Date.now();
    const asks = (at: number) => verifyInboundSignature(forged.clone(), bytes(), { fetch: down.fetch, now: at });
    for (let i = 0; i < 5; i++) expect(await asks(now + i * 1000)).toEqual({ ok: false, reason: 'invalid' });
    expect(down.requests.filter((request) => request.url === sender.id)).toHaveLength(1);

    // A minute on, one more try; and another actor is not held back by this one's.
    expect(await asks(now + keyRefetchAfterMs + 1000)).toEqual({ ok: false, reason: 'invalid' });
    expect(down.requests.filter((request) => request.url === sender.id)).toHaveLength(2);
    const stranger = actorDocument('lemmy.test', 'stranger', { publicKeyPem: '' });
    const strangerKey = `${stranger.id}#main-key`;
    const otherHeaders = signDelivery({ keyId: strangerKey, privateKeyPem: rsaKeys().privateKeyPem }, inbox, body);
    const other = new Request(inbox, { method: 'POST', headers: otherHeaders, body });
    expect(await verifyInboundSignature(other, bytes(), { fetch: down.fetch, now })).toEqual({ ok: false, reason: 'key_unknown' });
    expect(down.requests.filter((request) => request.url === stranger.id)).toHaveLength(1);
  });

  test('the refresh throttle remembers a hash of the key id, however long the sender made it', async () => {
    const longKeyId = `https://lemmy.test/u/${'x'.repeat(6000)}#main-key`;
    const headers = signDelivery({ keyId: longKeyId, privateKeyPem: rsaKeys().privateKeyPem }, inbox, body);
    const request = new Request(inbox, { method: 'POST', headers, body });
    const down = stubFetch({});
    expect(await verifyInboundSignature(request, bytes(), { fetch: down.fetch })).toEqual({ ok: false, reason: 'key_unknown' });
    expect(down.requests.length).toBeGreaterThan(0);
    const remembered = (globalThis as { __peblishKeyRefreshes?: Map<string, number> }).__peblishKeyRefreshes!;
    expect([...remembered.keys()].map((key) => key.length)).toEqual([43]);
  });

  test('a key id that is a document of its own (GoToSocial) is resolved through the owner it names', async () => {
    const keys = rsaKeys();
    const actorId = 'https://gts.test/users/alice';
    const gtsKeyId = `${actorId}/main-key`;
    const actor = {
      ...actorDocument('gts.test', 'alice', { publicKeyPem: keys.publicKeyPem }),
      id: actorId,
      inbox: `${actorId}/inbox`,
      outbox: `${actorId}/outbox`,
      followers: `${actorId}/followers`,
      publicKey: { id: gtsKeyId, owner: actorId, publicKeyPem: keys.publicKeyPem },
    };
    const keyDocument = { id: gtsKeyId, owner: actorId, publicKeyPem: keys.publicKeyPem };
    const { fetch, requests } = stubFetch({ [gtsKeyId]: { body: keyDocument }, [actorId]: { body: actor } });
    const request = new Request(inbox, {
      method: 'POST',
      headers: signDelivery({ keyId: gtsKeyId, privateKeyPem: keys.privateKeyPem }, inbox, body),
      body,
    });
    expect(await verifyInboundSignature(request, bytes(), { fetch })).toEqual({ ok: true, keyId: gtsKeyId, ownerApId: actorId });
    expect(requests.map((each) => each.url).slice(0, 2)).toEqual([gtsKeyId, actorId]);
  });

  test('a key document on one origin cannot name an owner on another', async () => {
    const keys = rsaKeys();
    const victim = actorDocument('lemmy.test', 'victim', { publicKeyPem: keys.publicKeyPem });
    const evilKeyId = 'https://evil.test/users/mallory/main-key';
    const { fetch, requests } = stubFetch({
      [evilKeyId]: { body: { id: evilKeyId, owner: victim.id, publicKeyPem: keys.publicKeyPem } },
      [victim.id]: { body: victim },
    });
    const request = new Request(inbox, {
      method: 'POST',
      headers: signDelivery({ keyId: evilKeyId, privateKeyPem: keys.privateKeyPem }, inbox, body),
      body,
    });
    expect(await verifyInboundSignature(request, bytes(), { fetch })).toEqual({ ok: false, reason: 'key_unknown' });
    expect(requests.some((each) => each.url === victim.id)).toBe(false);
  });

  test('a stranger’s signature, an unreachable actor and one of our own keys are all refused', async () => {
    const keys = rsaKeys();
    const { fetch } = stubFetch({ [sender.id]: { body: document(rsaKeys().publicKeyPem) } });
    expect(await verifyInboundSignature(await signed(keys.privateKeyPem), bytes(), { fetch })).toEqual({ ok: false, reason: 'invalid' });

    const gone = stubFetch({});
    const other = await signed(keys.privateKeyPem);
    await truncateAll();
    await seedLocalInstance();
    expect(await verifyInboundSignature(other, bytes(), { fetch: gone.fetch })).toEqual({ ok: false, reason: 'key_unknown' });

    const [instanceActor] = await db().select().from(actors).where(eq(actors.kind, 'Application'));
    await writer()
      .insert(actorKeys)
      .values({ actorId: instanceActor!.id, keyId: 'https://fed-a.test/#main-key', algorithm: 'rsa', publicKeyPem: keys.publicKeyPem });
    const ours = new Request(inbox, {
      method: 'POST',
      headers: signDelivery({ keyId: 'https://fed-a.test/#main-key', privateKeyPem: keys.privateKeyPem }, inbox, body),
      body,
    });
    expect(await verifyInboundSignature(ours, bytes(), { fetch: gone.fetch })).toEqual({ ok: false, reason: 'key_unknown' });
  });

  test('a body that changed in transit is refused before any key is looked for', async () => {
    const keys = rsaKeys();
    const { fetch, requests } = stubFetch({ [sender.id]: { body: document(keys.publicKeyPem) } });
    expect(await verifyInboundSignature(await signed(keys.privateKeyPem), bytes(`${body} `), { fetch })).toEqual({
      ok: false,
      reason: 'digest',
    });
    expect(requests).toHaveLength(0);
  });
});
