import { type } from 'arktype';
import type { EdgeConfig } from './config.ts';
import { ALL_TAG, type Purge } from './tags.ts';

// The one outbound client to api.cloudflare.com: a purge by Cache-Tag. Its address is fixed and
// its token is operator configuration, so it does not go through safeFetch (like the S3
// adapter). What it reports is built from the HTTP status and Cloudflare's numeric error codes
// only: never the token, the request, or an error message that could echo either.

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/** Cloudflare takes at most this many tags in one purge request (every plan). */
export const MAX_TAGS_PER_PURGE = 100;
export const PURGE_TIMEOUT_MS = 10_000;
/** The longest a 429's Retry-After is honoured for, and the wait when it names none. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;

export type PurgeResult = { ok: true } | { ok: false; why: string; retryAfterMs: number | null };

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

const Answer = type({ success: 'boolean', 'errors?': type({ code: 'number' }).array() });

function retryAfter(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : DEFAULT_RETRY_AFTER_MS;
}

/**
 * Purges every cached answer carrying one of `purge`'s tags (`all`: the wide tag) from the zone.
 * Success means Cloudflare accepted it; Cloudflare does not confirm what it evicted. Never throws.
 */
export async function purgeTags(
  config: EdgeConfig,
  purge: Purge,
  { fetch = globalThis.fetch, timeoutMs = PURGE_TIMEOUT_MS }: { fetch?: HttpFetch; timeoutMs?: number } = {},
): Promise<PurgeResult> {
  const tags = purge === 'all' ? [ALL_TAG] : purge;
  if (tags.length === 0) return { ok: true };
  if (tags.length > MAX_TAGS_PER_PURGE) throw new RangeError(`at most ${MAX_TAGS_PER_PURGE} tags in one purge`);
  let response: Response;
  try {
    response = await fetch(`${CLOUDFLARE_API}/zones/${config.zoneId}/purge_cache`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    // The name only (TimeoutError, TypeError): a message could quote the request.
    return { ok: false, why: error instanceof Error ? error.name : 'error', retryAfterMs: null };
  }
  let answer: typeof Answer.infer | null = null;
  try {
    const parsed = Answer(await response.json());
    answer = parsed instanceof type.errors ? null : parsed;
  } catch {
    // Not JSON: judged by the status alone.
  }
  if (response.ok && answer?.success === true) return { ok: true };
  const codes = answer?.errors?.map((error) => error.code).join(',');
  return {
    ok: false,
    why: `http ${response.status}${codes ? ` (cloudflare ${codes})` : ''}`,
    retryAfterMs: response.status === 429 ? retryAfter(response.headers.get('retry-after')) : null,
  };
}
