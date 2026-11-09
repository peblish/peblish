import { BlockedDestinationError, FetchTimeoutError, safeFetch, type SafeFetchInit, type SafeResponse } from '../net/fetch.ts';
import { sniffRaster, type RasterType } from './sniff.ts';

// The fetch behind the remote-media proxy route: one image, held in memory for the length of
// one response and never stored. Decision 5 is why it exists (viewers never talk to remote
// hosts), so what it sends upstream is fixed here: no viewer header of any kind.

export const proxyLimits = {
  /** A phone photo posted to a Lemmy instance is the usual large one; pict-rs keeps uploads at or under 10 MB. */
  bytes: 10 * 1024 * 1024,
  redirects: 3,
  timeoutMs: 15_000,
};

export type ProxyResult =
  | { ok: true; type: RasterType; body: Uint8Array }
  | { ok: false; status: 403 | 413 | 415 | 502 | 504; why: 'blocked' | 'too_large' | 'not_a_raster_image' | 'upstream' | 'timeout' };

type Fetcher = (url: string, init: SafeFetchInit) => Promise<SafeResponse>;

/**
 * The image at `url`. Only JPEG, PNG, GIF, WebP and AVIF pass, judged by their first bytes
 * and not by the type the remote host claims (SVG, HTML and everything else are refused with
 * 415), so the type the proxy answers with is its own. `fetch` is safeFetch unless a test
 * brings a stub.
 */
export async function fetchProxiedImage(url: string, fetch: Fetcher = safeFetch): Promise<ProxyResult> {
  let response: SafeResponse;
  try {
    response = await fetch(url, {
      schemes: ['https:', 'http:'],
      maxRedirects: proxyLimits.redirects,
      maxBytes: proxyLimits.bytes,
      timeoutMs: proxyLimits.timeoutMs,
      headers: { accept: 'image/avif,image/webp,image/*', 'user-agent': 'peblish-media-proxy/1' },
    });
  } catch (error) {
    if (error instanceof BlockedDestinationError) return { ok: false, status: 403, why: 'blocked' };
    if (error instanceof FetchTimeoutError) return { ok: false, status: 504, why: 'timeout' };
    return { ok: false, status: 502, why: 'upstream' };
  }
  if (response.status !== 200) return { ok: false, status: 502, why: 'upstream' };
  if (response.truncated) return { ok: false, status: 413, why: 'too_large' };
  const type = sniffRaster(response.body);
  if (!type) return { ok: false, status: 415, why: 'not_a_raster_image' };
  return { ok: true, type, body: response.body };
}
