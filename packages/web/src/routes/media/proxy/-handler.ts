import { fetchProxiedImage, type ProxyResult } from '@peblish/core/media/proxy';
import { unwrapProxyUrl, verifyProxyPath, type MediaContent } from '@peblish/core/media/proxy-url';
import { safeFetch, type SafeFetchInit, type SafeResponse } from '@peblish/core/net/fetch';
import { mediaAllowed, supplierMediaAllowed } from '@peblish/core/peers/gate';
import { EDGE_MAX_AGE_SECONDS } from '@peblish/core/edge/config';
import type { PublicAnswer, PublicCheck } from '@peblish/core/edge/public';
import { deadlineBody } from '@peblish/core/edge/stream';
import { PUBLIC_BODY_MS } from '@peblish/core/edge/timing';
import { hashListed, imageSha256 } from '@peblish/core/media/blocked';

// The remote-media proxy's answer (decision 5): the image bytes of one signed URL, held in memory
// for this response and stored nowhere. Viewers never contact remote hosts; remote hosts see
// this server and nothing of the viewer (fetchProxiedImage sends no viewer header).

/**
 * Minutes, not days: a takedown or the kill switch reaches viewers within this time, as a browser
 * keeps an image this long. Shared caches hold only public answers (`edge` below), and for at
 * most EDGE_MAX_AGE_SECONDS, purged on takedown.
 */
export const PROXY_MAX_AGE_SECONDS = 600;

/** What a busy proxy tells the browser: the same image is worth asking for again in a moment. */
export const PROXY_RETRY_AFTER_SECONDS = 2;

const plain = (status: number, text: string) =>
  new Response(`${text}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(status === 503 && { 'retry-after': String(PROXY_RETRY_AFTER_SECONDS) }),
    },
  });

type Fetcher = (url: string, init: SafeFetchInit) => Promise<SafeResponse>;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * `fetch` one hop at a time, asking `allowed` about each redirect's host before it is contacted,
 * so a peer whose media is quarantined, purged or blocked is never fetched, however the first host
 * points there. A refused hop calls `onDenied` and fails the fetch. The hop count and the one
 * deadline are still the caller's (`init.maxRedirects`, `init.timeoutMs`).
 */
export function gatedFetch(fetch: Fetcher, allowed: (host: string) => Promise<boolean>, onDenied: () => void): Fetcher {
  return async (url, init) => {
    const deadline = Date.now() + init.timeoutMs;
    let target = url;
    for (let redirects = 0; ; redirects++) {
      const hop = await fetch(target, { ...init, maxRedirects: 0, timeoutMs: Math.max(1, deadline - Date.now()) });
      const location = hop.headers.get('location');
      const next = location === null ? null : URL.parse(location, target);
      if (!REDIRECTS.has(hop.status) || next === null || redirects >= init.maxRedirects) return hop;
      if (!(await allowed(next.host))) {
        onDenied();
        throw new Error(`a redirect to ${next.host}, whose media is not allowed`);
      }
      target = next.href;
    }
  };
}

export type ProxyDeps = {
  key: Buffer;
  /** The remote_media.enabled kill switch. */
  enabled: boolean;
  /**
   * Whether the content the URL was signed for is still shown to the viewer making this request
   * (core media/reference.ts contentShown, with the viewer's session and NSFW choice).
   */
  contentShown: (content: MediaContent) => Promise<boolean>;
  /** The viewer's request signal: a request that gives up while queued for a turn is dropped. */
  signal?: AbortSignal;
  fetchImage?: (url: string, signal?: AbortSignal) => Promise<ProxyResult>;
  /** Whether the image's host, and each host it redirects to, may be proxied (peers/gate.ts: a peer's media waits for an admin's approval). */
  mediaAllowed?: (host: string) => Promise<boolean>;
  /** Whether images of content the peer at this host supplied may be proxied, wherever they are hosted (peers/gate.ts). */
  supplierAllowed?: (host: string) => Promise<boolean>;
  /** The HTTP client under the default fetchImage (safeFetch); tests bring a stub. */
  fetch?: Fetcher;
  /** The time an unbound URL's expiry is judged at (milliseconds); tests set it. */
  now?: number;
  /** Whether the blocked-image list holds a hash (core media/blocked.ts); a listed image is never served. */
  hashListed?: (sha256: string) => Promise<boolean>;
  /**
   * Edge caching, given only for a GET when its purge path is configured (core edge/config.ts).
   * `publicTags` (core edge/public.ts publicAnswerTags) is the one consistent read, after the
   * fetch, that says whether the answer may be public, with which Cache-Tag values and when its
   * deadline started; null keeps it private. It depends on the content, the hosts and the bytes,
   * never on who asks.
   */
  edge?: { publicTags: (check: PublicCheck) => Promise<PublicAnswer | null> } | null;
};

const imageHeaders = (type: string, length: number, cacheControl: string, extra: Record<string, string> = {}) => ({
  // The type sniffed from the bytes, never the remote host's claim.
  'content-type': type,
  'content-length': String(length),
  'cache-control': cacheControl,
  ...extra,
  'x-content-type-options': 'nosniff',
  // If someone opens the URL itself, the response can run nothing and load nothing.
  'content-security-policy': "default-src 'none'; sandbox",
  'referrer-policy': 'no-referrer',
});

export async function proxyResponse(signature: string, target: string, deps: ProxyDeps): Promise<Response> {
  // An unsigned, altered, foreign or expired URL, and the kill switch, look the same from outside: nothing here.
  const verified = verifyProxyPath(deps.key, signature, target, deps.now);
  if (verified === null || !deps.enabled) return plain(404, 'not found');
  // So does a URL that is itself one of this instance's proxy paths: it would be judged by the content
  // and supplier it was first signed for. imageSource never signs one (it unwraps it).
  if (unwrapProxyUrl(deps.key, new URL(verified.url)) !== null) return plain(404, 'not found');
  // So does an image of content a quarantined, purged or blocked peer supplied, wherever the image
  // is hosted, and one whose content was removed, deleted or is gated for this viewer.
  const { content } = verified;
  if (content?.supplier && !(await (deps.supplierAllowed ?? supplierMediaAllowed)(content.supplier))) return plain(404, 'not found');
  if (content && !(await deps.contentShown(content))) return plain(404, 'not found');
  const { url } = verified;
  // A quarantined, purged or blocked peer's media looks like any other missing image, here or after a redirect.
  const allowed = deps.mediaAllowed ?? mediaAllowed;
  const hosts = [new URL(url).host];
  if (!(await allowed(hosts[0]!))) return plain(404, 'not found');
  let denied = false;
  const visit = async (host: string) => {
    hosts.push(host);
    return allowed(host);
  };
  const fetch = gatedFetch(deps.fetch ?? safeFetch, visit, () => (denied = true));
  const fetchImage = deps.fetchImage ?? ((target: string, signal?: AbortSignal) => fetchProxiedImage(target, { signal, fetch }));
  const result = await fetchImage(url, deps.signal);
  if (denied) return plain(404, 'not found');
  if (!result.ok) return plain(result.status, `the image could not be proxied (${result.why})`);
  // A copy: the fetched buffer's type is wider than a Response body accepts.
  const body = new Uint8Array(result.body);
  // An image whose exact bytes are on the blocked-image list is refused like any missing image.
  const sha256 = imageSha256(body);
  if (await (deps.hashListed ?? hashListed)(sha256)) return plain(404, 'not found');
  // Public only by the one consistent read taken now the bytes are here, and sent at once; the
  // viewer was judged above for the private answer and plays no part in this one.
  const answer = deps.edge && content ? await deps.edge.publicTags({ content, hosts: [...new Set(hosts)], sha256 }) : null;
  if (answer) {
    const cacheControl = `public, max-age=${PROXY_MAX_AGE_SECONDS}, s-maxage=${EDGE_MAX_AGE_SECONDS}`;
    // A body the server must hand over before the deadline, or the socket is cut (core edge/stream.ts).
    // The log names the image by its hash: the proxy path carries the remote URL.
    const onLate = () =>
      console.error(`edge cache: a public proxy answer was cut off at the ${PUBLIC_BODY_MS} ms body deadline (image ${sha256})`);
    return new Response(deadlineBody(body, answer.startedAt + PUBLIC_BODY_MS, { onLate }), {
      headers: imageHeaders(result.type, body.byteLength, cacheControl, { 'cache-tag': answer.tags.join(',') }),
    });
  }
  return new Response(body, { headers: imageHeaders(result.type, body.byteLength, `private, max-age=${PROXY_MAX_AGE_SECONDS}`) });
}
