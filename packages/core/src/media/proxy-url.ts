import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Uuid } from '@peblish/schema/ids';
import { derivedKey } from '../identity/auth.ts';

// Signed URLs for the remote-media proxy (decision 5): /media/proxy/<signature>/<target>.
// <target> is a reference in base64url, and <signature> an HMAC-SHA-256 of it, so the proxy
// fetches only images this instance itself rendered into a page. It is not an open proxy:
// nobody else can make it fetch a URL of their choosing. The key comes from BETTER_AUTH_SECRET
// through the identity module's derivedKey (a fixed purpose label), so there is no new variable.
//
// A reference names the content the image was shown for (a post, a comment, or an actor's
// profile or community page), so the proxy can refuse it once that content is removed,
// deleted or gated for the viewer (reference.ts): a saved URL dies with its content and no
// list of revoked URLs is kept. It also names the peer that supplied that content, so a
// quarantined or blocked peer's images are refused wherever they are hosted (peers/gate.ts). An image shown outside any content (a preview of a draft, a
// site page) gets a reference that expires instead, after one to two hours.

export const PROXY_PATH = '/media/proxy';
const PURPOSE = 'media-proxy';
/**
 * Longest remote URL the proxy signs, in UTF-8 bytes (the bytes that are signed and carried in
 * the path); a longer URL cannot be proxied and renders as a link. Both sides measure the same:
 * the target is at most the unpadded base64url of this many bytes plus the reference's head.
 */
const MAX_URL_BYTES = 2048;
/** The head before the URL: a kind letter, a uuid and the supplier's host (253 characters and a port at most), or a time. */
const MAX_HEAD_BYTES = 320;
const MAX_TARGET_LENGTH = Math.ceil(((MAX_URL_BYTES + MAX_HEAD_BYTES) * 4) / 3);
/** An unbound reference is valid until the end of the hour after the one it was made in, so a page's URLs stay the same within an hour. */
const HOUR_SECONDS = 3600;

/**
 * The content an image is shown for. `actor` is a profile (avatar, bio) or a community page
 * (icon, banner, sidebar, rules). `supplier` is the host of the peer the content came from, null
 * for this instance's own.
 */
export type MediaContent = { kind: 'post' | 'comment' | 'actor'; id: Uuid; supplier: string | null };

/** What a valid proxy path names: the remote URL, and the content it was shown for (null for an unexpired unbound reference). */
export type ProxyTarget = { url: string; content: MediaContent | null };

const letters = { post: 'p', comment: 'c', actor: 'a' } as const;
const kindOf = (letter: string): MediaContent['kind'] => (letter === 'p' ? 'post' : letter === 'c' ? 'comment' : 'actor');
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const boundHead = new RegExp(`^([pca]) (${uuid}) (\\S{1,300})$`);
const unboundHead = /^t (\d{1,12})$/;

/** The HMAC key for proxy URLs. */
export const mediaProxyKey = () => derivedKey(PURPOSE);

const sign = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('base64url');

/** The head of a reference: the content, or the second an unbound one stops being valid. */
function headOf(content: MediaContent | null, now: number): string {
  if (content) return `${letters[content.kind]} ${content.id.toLowerCase()} ${content.supplier?.toLowerCase() ?? '-'}`;
  return `t ${(Math.floor(now / 1000 / HOUR_SECONDS) + 2) * HOUR_SECONDS}`;
}

/**
 * The proxy path for a remote image URL shown for `content` (no content: a reference that
 * expires); throws RangeError for a URL over 2,048 bytes (imageSource turns that into null).
 */
export function proxyUrlBuilder(key: Buffer, now: () => number = Date.now): (url: string, content?: MediaContent | null) => string {
  return (url, content = null) => {
    if (Buffer.byteLength(url) > MAX_URL_BYTES) throw new RangeError('the image URL is too long to proxy');
    // The URL is everything after the first line break, so it may hold anything; the head never holds one.
    const payload = `${headOf(content, now())}\n${url}`;
    return `${PROXY_PATH}/${sign(key, payload)}/${Buffer.from(payload).toString('base64url')}`;
  };
}

/** The URL a reference carries when `signature` is the HMAC of `target` under `key`, whatever its head says; null otherwise. */
function carried(key: Buffer, signature: string, target: string): { head: string; url: string } | null {
  if (target.length > MAX_TARGET_LENGTH) return null;
  const payload = Buffer.from(target, 'base64url').toString('utf8');
  const expected = Buffer.from(sign(key, payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const split = payload.indexOf('\n');
  return split < 0 ? null : { head: payload.slice(0, split), url: payload.slice(split + 1) };
}

/** A percent-decoded path, or the path itself when it does not decode. */
function decodedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Whether a URL's path is one the proxy route answers, read as a router may read it: in any case
 * and percent-decoded. Such a path under this instance's origin is never an image source as it
 * stands (image-src.ts): it is unwrapped or dropped.
 */
export function isProxyPath(url: URL): boolean {
  return decodedPath(url.pathname).toLowerCase().startsWith(`${PROXY_PATH}/`);
}

/**
 * The remote URL inside a proxy path this instance signed under `key`, on whatever host it is
 * written (a copied page URL keeps its host), so it can be signed again for the content it is
 * shown in now and never borrows the content and supplier it was first signed for. Expiry and the
 * head are not judged: nothing is authorized by unwrapping. Null when `url` is not such a path.
 */
export function unwrapProxyUrl(key: Buffer, url: URL): string | null {
  if (!isProxyPath(url)) return null;
  const [signature, target, ...rest] = decodedPath(url.pathname)
    .slice(PROXY_PATH.length + 1)
    .split('/');
  if (!signature || !target || rest.length > 0) return null;
  return carried(key, signature, target)?.url ?? null;
}

/**
 * What a proxy path names, when its signature is the HMAC of its target under `key`, an
 * unbound reference has not expired at `now`, and the URL is an absolute http or https URL
 * without credentials; null otherwise.
 */
export function verifyProxyPath(key: Buffer, signature: string, target: string, now: number = Date.now()): ProxyTarget | null {
  const reference = carried(key, signature, target);
  if (!reference) return null;
  const { head, url } = reference;
  let content: MediaContent | null = null;
  const [, letter, id, supplier] = boundHead.exec(head) ?? [];
  if (letter && id && supplier) content = { kind: kindOf(letter), id, supplier: supplier === '-' ? null : supplier };
  else {
    const until = unboundHead.exec(head);
    if (!until || Number(until[1]) * 1000 <= now) return null;
  }
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password ? { url, content } : null;
  } catch {
    return null;
  }
}
