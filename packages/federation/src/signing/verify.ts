import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

// Inbound HTTP signatures, draft-cavage-http-signatures-12 with RSA keys. We read the keys from
// actor_keys (inbound.ts) instead of going through Fedify's verifyRequest: in Fedify 2.4 that
// fetches the key and then its owner as JSON-LD documents, which would fetch a peer's @context
// for every check and bypass our one document reader. RFC 9421 (Mastodon 4.4+ may sign with it
// when asked) is not read yet; a request signed that way fails as `missing`.

export type SignatureFailure =
  /** No Signature header (or one this verifier does not read, such as RFC 9421's). */
  | 'missing'
  /** The header does not parse, names an unsupported algorithm, or does not cover what it must. */
  | 'malformed'
  /** Date is outside the allowed window. */
  | 'expired'
  /** The Digest header is absent or does not match the body. */
  | 'digest'
  /** No public key for the keyId. */
  | 'key_unknown'
  /** The signature does not verify under the key. */
  | 'invalid';

/** A parsed Signature header whose Date and Digest checks passed; the key is the only thing left to check. */
export type ParsedSignature = {
  keyId: string;
  /** The exact bytes that were signed. */
  signingString: string;
  signature: Buffer;
};

/** The window around now that a signed Date may fall in, matching Fedify's default. */
export const dateWindowMs = 60 * 60 * 1000;

/** Headers a POST's signature must cover: its target, the host, the time and the body's digest. */
const required = ['(request-target)', 'host', 'date', 'digest'];

/** `key="value"` pairs of a Signature header; unquoted values (numbers) are read too. */
function params(header: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of header.matchAll(/([A-Za-z]+)=(?:"([^"]*)"|([^,\s]+))/g)) out.set(match[1]!.toLowerCase(), match[2] ?? match[3]!);
  return out;
}

/** `SHA-256=<base64>` (any case, the first sha-256 entry of a comma-separated list), as raw bytes. */
function sha256Digest(header: string): Buffer | null {
  for (const entry of header.split(',')) {
    const [algorithm, ...rest] = entry.trim().split('=');
    if (algorithm?.toLowerCase() === 'sha-256') return Buffer.from(rest.join('='), 'base64');
  }
  return null;
}

/**
 * Reads the Signature header of an inbox POST and checks everything that does not need the key:
 * the covered headers, the Date window and the body's Digest. `body` is the exact bytes received.
 */
export function parseSignature(request: Request, body: Uint8Array, now = Date.now()): ParsedSignature | SignatureFailure {
  const header = request.headers.get('signature');
  if (!header) return 'missing';
  const fields = params(header);
  const keyId = fields.get('keyid');
  const signature = fields.get('signature');
  const algorithm = fields.get('algorithm')?.toLowerCase();
  // hs2019 names no algorithm of its own; with an RSA key it means rsa-sha256 (Mastodon, Mbin).
  if (!keyId || !signature || (algorithm && algorithm !== 'rsa-sha256' && algorithm !== 'hs2019')) return 'malformed';
  const covered = (fields.get('headers') ?? 'date').toLowerCase().split(/\s+/).filter(Boolean);
  if (!required.every((name) => covered.includes(name))) return 'malformed';

  const date = Date.parse(request.headers.get('date') ?? '');
  if (Number.isNaN(date) || Math.abs(now - date) > dateWindowMs) return 'expired';
  const digest = request.headers.get('digest');
  const claimed = digest ? sha256Digest(digest) : null;
  const actual = createHash('sha256').update(body).digest();
  if (!claimed || claimed.length !== actual.length || !timingSafeEqual(claimed, actual)) return 'digest';

  const { pathname, search } = new URL(request.url);
  const lines: string[] = [];
  for (const name of covered) {
    if (name === '(request-target)') {
      lines.push(`(request-target): ${request.method.toLowerCase()} ${pathname}${search}`);
      continue;
    }
    // (created) and (expires) belong to the newer drafts; a request covering them is not ours to read.
    const value = name.startsWith('(') ? null : request.headers.get(name);
    if (value === null) return 'malformed';
    lines.push(`${name}: ${value.trim()}`);
  }
  return { keyId, signingString: lines.join('\n'), signature: Buffer.from(signature, 'base64') };
}

/** Whether `parsed` verifies under `publicKeyPem` (SPKI or PKCS#1). Only RSA keys of 2048 bits or more count. */
export function signatureVerifies(parsed: ParsedSignature, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return false;
    return verify('sha256', Buffer.from(parsed.signingString), key, parsed.signature);
  } catch {
    return false;
  }
}
