import { BlockedDestinationError, FetchTimeoutError, safeFetch, type SafeFetchInit, type SafeResponse } from '../net/fetch.ts';
import { createSlots, type Slots } from './slots.ts';
import { sniffRaster, type RasterType } from './sniff.ts';

// The fetch behind the remote-media proxy route: one image, held in memory for the length of
// one response and never stored. Decision 5 is why it exists (viewers never talk to remote
// hosts), so what it sends upstream is fixed here: no viewer header of any kind.

export const proxyLimits = {
  /** A phone photo posted to a Lemmy instance is the usual large one; pict-rs keeps uploads at or under 10 MB. */
  bytes: 10 * 1024 * 1024,
  redirects: 3,
  timeoutMs: 15_000,
  /**
   * Upstream fetches at once in this process, and how many more may wait for a turn. The signed
   * URL of a page's image is public, so anyone can ask for it again and again: each fetch holds up
   * to `bytes` in memory (32 of them: 320 MiB at the very worst, a few MiB in practice), and
   * past the queue the answer is a 503. A per-address limiter is a later item (it needs a throttle scope).
   */
  concurrent: 32,
  queued: 64,
};

const upstream = createSlots(proxyLimits.concurrent, proxyLimits.queued);

export type ProxyResult =
  | { ok: true; type: RasterType; body: Uint8Array }
  | {
      ok: false;
      status: 403 | 413 | 415 | 502 | 503 | 504;
      why: 'blocked' | 'too_large' | 'not_a_raster_image' | 'upstream' | 'timeout' | 'busy';
    };

type Fetcher = (url: string, init: SafeFetchInit) => Promise<SafeResponse>;

/**
 * The image at `url`. Only JPEG, PNG, GIF, WebP and AVIF pass, judged by their first bytes
 * and not by the type the remote host claims (SVG, HTML and everything else are refused with
 * 415), so the type the proxy answers with is its own. At most `proxyLimits.concurrent` fetches
 * run at once; a request waits for a turn behind up to `proxyLimits.queued` others and is
 * refused with 503 beyond that. `fetch` is safeFetch unless a test brings a stub.
 */
export async function fetchProxiedImage(url: string, fetch: Fetcher = safeFetch, slots: Slots = upstream): Promise<ProxyResult> {
  const release = await slots.acquire();
  if (!release) return { ok: false, status: 503, why: 'busy' };
  try {
    return await fetchImage(url, fetch);
  } finally {
    release();
  }
}

async function fetchImage(url: string, fetch: Fetcher): Promise<ProxyResult> {
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
