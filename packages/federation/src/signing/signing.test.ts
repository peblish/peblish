import { generateKeyPairSync } from 'node:crypto';
import { signRequest, verifyRequestDetailed } from '@fedify/fedify';
import { describe, expect, test } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { signDelivery, signFetch, type SigningKey } from './sign.ts';
import { dateWindowMs, parseSignature, signatureVerifies, type SignatureFailure } from './verify.ts';

// The fixture key is generated once per run; nothing here is a real actor's.
const pair = (modulusLength: number, privateType: 'pkcs8' | 'pkcs1' = 'pkcs8') =>
  generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: privateType, format: 'pem' },
  });

const keyId = 'https://sender.test/ap/u.alice#main-key';
const owner = 'https://sender.test/ap/u.alice';
const inbox = 'https://receiver.test/inbox';
const body = JSON.stringify({ type: 'Like', id: 'https://sender.test/ap/activity/1' });
const { publicKey, privateKey } = pair(2048);
const signingKey: SigningKey = { keyId, privateKeyPem: privateKey };

/** What the receiving side sees: the signed headers on a request carrying `body`. */
const received = (headers: Headers, content = body, url = inbox) => new Request(url, { method: 'POST', headers, body: content });
const bytes = (text: string) => new TextEncoder().encode(text);

function verdict(request: Request, content = body, pem = publicKey, now?: number): 'ok' | SignatureFailure {
  const parsed = parseSignature(request, bytes(content), now);
  if (typeof parsed === 'string') return parsed;
  return signatureVerifies(parsed, pem) ? 'ok' : 'invalid';
}

describe('signing and verifying', () => {
  test('a delivery we sign verifies, and names its key', async () => {
    const request = received(signDelivery(signingKey, inbox, body));
    expect(verdict(request)).toBe('ok');
    expect(parseSignature(request, bytes(body))).toMatchObject({ keyId });
  });

  test('a PKCS#1 private key (an imported actor) signs the same way', async () => {
    const old = pair(2048, 'pkcs1');
    expect(old.privateKey).toContain('BEGIN RSA PRIVATE KEY');
    const request = received(signDelivery({ keyId, privateKeyPem: old.privateKey }, inbox, body));
    expect(verdict(request, body, old.publicKey)).toBe('ok');
  });

  test('a request signed by Fedify itself, covering Content-Type too, verifies', async () => {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      Buffer.from(privateKey.replace(/-----[^-]+-----|\s/g, ''), 'base64'),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['sign'],
    );
    const signed = await signRequest(
      new Request(inbox, { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body }),
      key,
      new URL(keyId),
    );
    expect(signed.headers.get('signature')).toContain('content-type');
    expect(verdict(received(signed.headers))).toBe('ok');
  });

  test('Fedify verifies what we send, with a loader that serves the actor and its key', async () => {
    const request = received(signDelivery(signingKey, inbox, body));
    const result = await verifyRequestDetailed(request, {
      documentLoader: async (url) => ({
        contextUrl: null,
        documentUrl: url,
        document: {
          '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
          id: owner,
          type: 'Person',
          inbox: `${owner}/inbox`,
          publicKey: { id: keyId, owner, publicKeyPem: publicKey },
        },
      }),
    });
    expect(result.verified).toBe(true);
  });

  test('the signature covers the complete request target, query string included, and six headers', () => {
    const target = 'https://receiver.test/inbox?shard=2&tag=a%20b';
    const headers = signDelivery(signingKey, target, body);
    expect(headers.get('signature')).toContain('headers="(request-target) accept content-type date digest host"');
    const request = received(headers, body, target);
    expect(verdict(request)).toBe('ok');
    expect(parseSignature(request, bytes(body))).toMatchObject({
      signingString: expect.stringContaining('(request-target): post /inbox?shard=2&tag=a%20b\n'),
    });
    // The same headers do not vouch for the inbox without its query, or with another one.
    expect(verdict(received(headers, body, 'https://receiver.test/inbox'))).toBe('invalid');
    expect(verdict(received(headers, body, 'https://receiver.test/inbox?shard=3&tag=a%20b'))).toBe('invalid');
  });

  test('a signed GET covers the request target, host and date, and nothing else', () => {
    const target = 'https://peer.test/c/lab?page=2';
    const headers = signFetch(signingKey, target);
    expect([...headers.keys()].sort()).toEqual(['date', 'signature']);
    const signature = headers.get('signature')!;
    expect(signature).toContain(`keyId="${keyId}"`);
    expect(signature).toContain('algorithm="rsa-sha256"');
    expect(signature).toContain('headers="(request-target) host date"');
    // The string a peer rebuilds from the request it received.
    const message = `(request-target): get /c/lab?page=2\nhost: peer.test\ndate: ${headers.get('date')}`;
    const bytes64 = /signature="([^"]+)"/.exec(signature)![1]!;
    expect(verify('sha256', Buffer.from(message), createPublicKey(publicKey), Buffer.from(bytes64, 'base64'))).toBe(true);
    // A port stays in the Host, as a client writes it.
    expect(signFetch(signingKey, 'https://peer.test:8443/u/x').get('signature')).toContain('headers="(request-target) host date"');
  });

  test('Fedify’s verifier accepts our signed GET', async () => {
    const target = 'https://peer.test/c/lab';
    const request = new Request(target, { headers: { ...Object.fromEntries(signFetch(signingKey, target)), host: 'peer.test' } });
    const result = await verifyRequestDetailed(request, {
      documentLoader: async (url) => ({
        contextUrl: null,
        documentUrl: url,
        document: {
          '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
          id: owner,
          type: 'Person',
          inbox: `${owner}/inbox`,
          publicKey: { id: keyId, owner, publicKeyPem: publicKey },
        },
      }),
    });
    expect(result.verified).toBe(true);
  });

  test('every way a request can fail names its reason', async () => {
    const good = signDelivery(signingKey, inbox, body);
    const without = (name: string) => {
      const headers = new Headers(good);
      headers.delete(name);
      return headers;
    };
    const withSignature = (change: (signature: string) => string) => {
      const headers = new Headers(good);
      headers.set('signature', change(good.get('signature')!));
      return headers;
    };
    const other = pair(2048);
    const small = pair(1024);
    const smallSigned = signDelivery({ keyId, privateKeyPem: small.privateKey }, inbox, body);
    const table: [string, 'ok' | SignatureFailure][] = [
      ['no signature header', verdict(received(without('signature')))],
      ['a body changed in transit', verdict(received(good, `${body} `), `${body} `)],
      ['no digest header', verdict(received(without('digest')))],
      ['a different target path', verdict(received(good, body, 'https://receiver.test/other/inbox'))],
      ['a date past the window', verdict(received(good), body, publicKey, Date.now() + dateWindowMs + 60_000)],
      ['another actor key', verdict(received(good), body, other.publicKey)],
      [
        'a signature that does not decode to ours',
        verdict(received(withSignature((s) => s.replace(/signature="[^"]*"/, 'signature="AAAA"')))),
      ],
      ['an unsupported algorithm', verdict(received(withSignature((s) => s.replace('rsa-sha256', 'ed25519'))))],
      ['a signature that leaves out the digest', verdict(received(withSignature((s) => s.replace('digest ', ''))))],
      ['a 1024-bit key', verdict(received(smallSigned), body, small.publicKey)],
      ['a key that is not a key', verdict(received(good), body, 'not a pem')],
    ];
    expect(Object.fromEntries(table)).toEqual({
      'no signature header': 'missing',
      'a body changed in transit': 'digest',
      'no digest header': 'digest',
      'a different target path': 'invalid',
      'a date past the window': 'expired',
      'another actor key': 'invalid',
      'a signature that does not decode to ours': 'invalid',
      'an unsupported algorithm': 'malformed',
      'a signature that leaves out the digest': 'malformed',
      'a 1024-bit key': 'invalid',
      'a key that is not a key': 'invalid',
    });
  });
});
