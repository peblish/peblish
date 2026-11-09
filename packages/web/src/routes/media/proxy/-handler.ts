import { fetchProxiedImage, type ProxyResult } from '@peblish/core/media/proxy';
import { verifyProxyPath } from '@peblish/core/media/proxy-url';
import { mediaAllowed } from '@peblish/core/peers/gate';

// The remote-media proxy's answer (decision 5): the image bytes of one signed URL, held in memory
// for this response and stored nowhere. Viewers never contact remote hosts; remote hosts see
// this server and nothing of the viewer (fetchProxiedImage sends no viewer header).

/**
 * Minutes, not days: a takedown or the kill switch reaches viewers within this time. The answer is
 * `private`, so only the viewer's browser keeps it: no edge cache holds remote media for the beta
 * (revisit when lane SAFE's scanning is live).
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

export type ProxyDeps = {
  key: Buffer;
  /** The remote_media.enabled kill switch. */
  enabled: boolean;
  /** The viewer's request signal: a request that gives up while queued for a turn is dropped. */
  signal?: AbortSignal;
  fetchImage?: (url: string, signal?: AbortSignal) => Promise<ProxyResult>;
  /** Whether the image's host may be proxied (peers/gate.ts: a peer's media waits for an admin's approval). */
  mediaAllowed?: (host: string) => Promise<boolean>;
};

export async function proxyResponse(signature: string, target: string, deps: ProxyDeps): Promise<Response> {
  // An unsigned, altered or foreign URL, and the kill switch, look the same from outside: nothing here.
  const url = verifyProxyPath(deps.key, signature, target);
  if (url === null || !deps.enabled) return plain(404, 'not found');
  // A quarantined, purged or blocked peer's media looks like any other missing image.
  if (!(await (deps.mediaAllowed ?? mediaAllowed)(new URL(url).host))) return plain(404, 'not found');
  const fetchImage = deps.fetchImage ?? ((target: string, signal?: AbortSignal) => fetchProxiedImage(target, { signal }));
  const result = await fetchImage(url, deps.signal);
  if (!result.ok) return plain(result.status, `the image could not be proxied (${result.why})`);
  // A copy: the fetched buffer's type is wider than a Response body accepts.
  return new Response(new Uint8Array(result.body), {
    headers: {
      // The type sniffed from the bytes, never the remote host's claim.
      'content-type': result.type,
      'content-length': String(result.body.byteLength),
      'cache-control': `private, max-age=${PROXY_MAX_AGE_SECONDS}`,
      'x-content-type-options': 'nosniff',
      // If someone opens the URL itself, the response can run nothing and load nothing.
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
    },
  });
}
