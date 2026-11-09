import { fetchProxiedImage, type ProxyResult } from '@peblish/core/media/proxy';
import { verifyProxyPath } from '@peblish/core/media/proxy-url';

// The remote-media proxy's answer (decision 5): the image bytes of one signed URL, held in memory
// for this response and stored nowhere. Viewers never contact remote hosts; remote hosts see
// this server and nothing of the viewer (fetchProxiedImage sends no viewer header).

/** Minutes, not days: a takedown or the kill switch reaches viewers within this time. */
export const PROXY_MAX_AGE_SECONDS = 600;

const plain = (status: number, text: string) =>
  new Response(`${text}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

export type ProxyDeps = {
  key: Buffer;
  /** The remote_media.enabled kill switch. */
  enabled: boolean;
  fetchImage?: (url: string) => Promise<ProxyResult>;
};

export async function proxyResponse(signature: string, target: string, deps: ProxyDeps): Promise<Response> {
  // An unsigned, altered or foreign URL, and the kill switch, look the same from outside: nothing here.
  const url = verifyProxyPath(deps.key, signature, target);
  if (url === null || !deps.enabled) return plain(404, 'not found');
  const result = await (deps.fetchImage ?? fetchProxiedImage)(url);
  if (!result.ok) return plain(result.status, `the image could not be proxied (${result.why})`);
  // A copy: the fetched buffer's type is wider than a Response body accepts.
  return new Response(new Uint8Array(result.body), {
    headers: {
      // The type sniffed from the bytes, never the remote host's claim.
      'content-type': result.type,
      'content-length': String(result.body.byteLength),
      'cache-control': `public, max-age=${PROXY_MAX_AGE_SECONDS}`,
      'x-content-type-options': 'nosniff',
      // If someone opens the URL itself, the response can run nothing and load nothing.
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
    },
  });
}
