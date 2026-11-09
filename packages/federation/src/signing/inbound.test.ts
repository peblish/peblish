import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { writer } from '@peblish/core/db/write';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { truncateAll } from '@peblish/core/testing/db';
import { actorDocument, rsaKeys, seedLocalInstance, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { resolveRemoteActor } from '../actors/resolve.ts';
import { signDelivery } from './sign.ts';
import { verifyInboundSignature } from './inbound.ts';

const inbox = 'https://fed-a.test/inbox';
const body = JSON.stringify({ type: 'Like', id: 'https://lemmy.test/activities/1' });
const sender = actorDocument('lemmy.test', 'sender', { publicKeyPem: '' });
const keyId = `${sender.id}#main-key`;

/** A POST to our inbox signed with `privateKeyPem` as the sender's key. */
async function signed(privateKeyPem: string, content = body) {
  const headers = await signDelivery({ keyId, privateKeyPem }, inbox, content);
  return new Request(inbox, { method: 'POST', headers, body: content });
}
const bytes = (text = body) => new TextEncoder().encode(text);
const document = (publicKeyPem: string) => actorDocument('lemmy.test', 'sender', { publicKeyPem });

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
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
      headers: await signDelivery({ keyId: 'https://fed-a.test/#main-key', privateKeyPem: keys.privateKeyPem }, inbox, body),
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
