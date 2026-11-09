import { createHash, createPrivateKey, createSign, type KeyObject } from 'node:crypto';

// Outbound HTTP signatures: draft-cavage-http-signatures-12 (rsa-sha256), the one scheme Lemmy,
// PieFed, Mbin and Mastodon all verify. The delivery job calls this once per attempt and never
// retries a refused request under a second scheme (the spike's "double knock": Lemmy 0.19 cannot
// verify RFC 9421, so the second request failed with a digest error that hid the real one).
//
// We sign ourselves because Fedify's signer covers `url.pathname` for (request-target), and a
// peer reconstructs the target as path plus query: an inbox with a query string would never
// verify. The tests check these signatures with Fedify's verifier and Fedify's signatures with
// ours, so the header set stays what the peers accepted in the lab.

/** A local actor's signing key as actor_keys stores it. */
export type SigningKey = { keyId: string; privateKeyPem: string };

// Parsing a PEM costs a few milliseconds; a delivery run signs for the same few actors again
// and again. Bounded so a long-lived worker cannot grow it past the actors it signs for.
const imported = new Map<string, KeyObject>();
const importedMax = 256;

/** Node reads PKCS#1 and PKCS#8 PEMs alike (imported PieFed keys may be either). */
function privateKey(pem: string): KeyObject {
  const cached = imported.get(pem);
  if (cached) return cached;
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new TypeError('the signing key is not an RSA key');
  if (imported.size >= importedMax) imported.delete(imported.keys().next().value!);
  imported.set(pem, key);
  return key;
}

/**
 * Adds the Signature header covering `covered`, in that order, to `headers`: `(request-target)`
 * is `<method> <path><query>`, the complete target a peer reconstructs, and every other name is
 * a header already in `headers`.
 */
export function signHeaders(key: SigningKey, method: string, url: URL, headers: Headers, covered: readonly string[]): Headers {
  const message = covered
    .map(
      (name) =>
        `${name}: ${name === '(request-target)' ? `${method.toLowerCase()} ${url.pathname}${url.search}` : headers.get(name)?.trim()}`,
    )
    .join('\n');
  const signature = createSign('sha256').update(message).sign(privateKey(key.privateKeyPem)).toString('base64');
  const signed = new Headers(headers);
  signed.set('signature', `keyId="${key.keyId}",algorithm="rsa-sha256",headers="${covered.join(' ')}",signature="${signature}"`);
  return signed;
}

/**
 * The headers to POST `body` to `inbox` with: the body's Digest, Date, Host, Content-Type and
 * Accept, and the Signature over them and the request target. The same body can be signed
 * again for a retry; only Date and Signature change.
 */
export function signDelivery(key: SigningKey, inbox: string, body: string): Headers {
  const url = new URL(inbox);
  const headers = new Headers({
    accept: 'application/activity+json',
    'content-type': 'application/activity+json',
    date: new Date().toUTCString(),
    digest: `SHA-256=${createHash('sha256').update(body).digest('base64')}`,
    host: url.host,
  });
  return signHeaders(key, 'post', url, headers, ['(request-target)', 'accept', 'content-type', 'date', 'digest', 'host']);
}
