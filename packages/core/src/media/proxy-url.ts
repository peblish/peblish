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
// list of revoked URLs is kept. An image shown outside any content (a preview of a draft, a
// site page) gets a reference that expires instead, after one to two hours.

export const PROXY_PATH = '/media/proxy';
const PURPOSE = 'media-proxy';
/**
 * Longest remote URL the proxy signs, in UTF-8 bytes (the bytes that are signed and carried in
 * the path); a longer URL cannot be proxied and renders as a link. Both sides measure the same:
 * the target is at most the unpadded base64url of this many bytes plus the reference's head.
 */
const MAX_URL_BYTES = 2048;
/** The head before the URL: a kind letter and a uuid, or a time (with room to spare). */
const MAX_HEAD_BYTES = 320;
const MAX_TARGET_LENGTH = Math.ceil(((MAX_URL_BYTES + MAX_HEAD_BYTES) * 4) / 3);
/** An unbound reference is valid until the end of the hour after the one it was made in, so a page's URLs stay the same within an hour. */
const HOUR_SECONDS = 3600;

/** The content an image is shown for. `actor` is a profile (avatar, bio) or a community page (icon, banner, sidebar, rules). */
export type MediaContent = { kind: 'post' | 'comment' | 'actor'; id: Uuid };

/** What a valid proxy path names: the remote URL, and the content it was shown for (null for an unexpired unbound reference). */
export type ProxyTarget = { url: string; content: MediaContent | null };

const letters = { post: 'p', comment: 'c', actor: 'a' } as const;
const kindOf = (letter: string): MediaContent['kind'] => (letter === 'p' ? 'post' : letter === 'c' ? 'comment' : 'actor');
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const boundHead = new RegExp(`^([pca]) (${uuid})$`);
const unboundHead = /^t (\d{1,12})$/;

/** The HMAC key for proxy URLs. */
export const mediaProxyKey = () => derivedKey(PURPOSE);

const sign = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('base64url');

/** The head of a reference: the content, or the second an unbound one stops being valid. */
function headOf(content: MediaContent | null, now: number): string {
  if (content) return `${letters[content.kind]} ${content.id.toLowerCase()}`;
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

/**
 * What a proxy path names, when its signature is the HMAC of its target under `key`, an
 * unbound reference has not expired at `now`, and the URL is an absolute http or https URL
 * without credentials; null otherwise.
 */
export function verifyProxyPath(key: Buffer, signature: string, target: string, now: number = Date.now()): ProxyTarget | null {
  if (target.length > MAX_TARGET_LENGTH) return null;
  const payload = Buffer.from(target, 'base64url').toString('utf8');
  const expected = Buffer.from(sign(key, payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const split = payload.indexOf('\n');
  if (split < 0) return null;
  const head = payload.slice(0, split);
  const url = payload.slice(split + 1);
  let content: MediaContent | null = null;
  const [, letter, id] = boundHead.exec(head) ?? [];
  if (letter && id) content = { kind: kindOf(letter), id };
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
