import { createPrivateKey } from 'node:crypto';
import { signRequest } from '@fedify/fedify';

// Outbound HTTP signatures: draft-cavage-http-signatures-12 (rsa-sha256), the one scheme Lemmy,
// PieFed, Mbin and Mastodon all verify. Fedify's signRequest produces the exact header set the
// lab's peers accepted, so it signs; the delivery job calls this once per attempt and never
// retries a refused request under a second scheme (the spike's "double knock": Lemmy 0.19 cannot
// verify RFC 9421, so the second request failed with a digest error that hid the real one).

/** A local actor's signing key as actor_keys stores it. */
export type SigningKey = { keyId: string; privateKeyPem: string };

// Importing a PEM costs a few milliseconds; a delivery run signs for the same few actors again
// and again. Bounded so a long-lived worker cannot grow it past the actors it signs for.
const imported = new Map<string, CryptoKey>();
const importedMax = 256;

async function importKey({ keyId, privateKeyPem }: SigningKey): Promise<CryptoKey> {
  const cacheKey = `${keyId}\n${privateKeyPem}`;
  const cached = imported.get(cacheKey);
  if (cached) return cached;
  // Node reads PKCS#1 and PKCS#8 PEMs alike (imported PieFed keys may be either); WebCrypto
  // wants PKCS#8. Fedify's signRequest refuses a key that is not extractable.
  const der = createPrivateKey(privateKeyPem).export({ type: 'pkcs8', format: 'der' });
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
  if (imported.size >= importedMax) imported.delete(imported.keys().next().value!);
  imported.set(cacheKey, key);
  return key;
}

/**
 * The headers to POST `body` to `inbox` with: the body's Digest, Date, Host, Content-Type and
 * the Signature over them. The same body can be signed again for a retry; only Date and
 * Signature change.
 */
export async function signDelivery(key: SigningKey, inbox: string, body: string): Promise<Headers> {
  const request = new Request(inbox, {
    method: 'POST',
    headers: { 'content-type': 'application/activity+json', accept: 'application/activity+json' },
    body,
  });
  const signed = await signRequest(request, await importKey(key), new URL(key.keyId), {
    spec: 'draft-cavage-http-signatures-12',
    body: new TextEncoder().encode(body).buffer,
  });
  return signed.headers;
}
