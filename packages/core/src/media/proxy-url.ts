import { createHmac, timingSafeEqual } from 'node:crypto';
import { derivedKey } from '../identity/auth.ts';

// Signed URLs for the remote-media proxy (decision 5): /media/proxy/<signature>/<target>.
// <target> is the remote URL in base64url and <signature> an HMAC-SHA-256 of that URL, so the
// proxy fetches only URLs this instance itself rendered into a page. It is not an open proxy:
// nobody else can make it fetch a URL of their choosing. The key comes from BETTER_AUTH_SECRET
// through the identity module's derivedKey (a fixed purpose label), so there is no new variable.

export const PROXY_PATH = '/media/proxy';
const PURPOSE = 'media-proxy';
/** Longest remote URL the proxy signs; longer URLs cannot be proxied (they render as links). */
const MAX_URL_LENGTH = 2048;

/** The HMAC key for proxy URLs. */
export const mediaProxyKey = () => derivedKey(PURPOSE);

const sign = (key: Buffer, url: string) => createHmac('sha256', key).update(url).digest('base64url');

/** The proxy path for a remote image URL; throws RangeError for a URL too long to proxy (imageSource turns that into null). */
export function proxyUrlBuilder(key: Buffer): (url: string) => string {
  return (url) => {
    if (url.length > MAX_URL_LENGTH) throw new RangeError('the image URL is too long to proxy');
    return `${PROXY_PATH}/${sign(key, url)}/${Buffer.from(url).toString('base64url')}`;
  };
}

/**
 * The remote URL a proxy path carries, when its signature is the HMAC of that URL under `key`
 * and the URL is an absolute http or https URL without credentials; null otherwise.
 */
export function verifyProxyPath(key: Buffer, signature: string, target: string): string | null {
  if (target.length > Math.ceil((MAX_URL_LENGTH * 4) / 3) + 4) return null;
  const url = Buffer.from(target, 'base64url').toString('utf8');
  const expected = Buffer.from(sign(key, url));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password ? url : null;
  } catch {
    return null;
  }
}
