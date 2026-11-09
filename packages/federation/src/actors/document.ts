import { userAgent } from '../federation.ts';
import { instanceSigningKey } from '../signing/instance.ts';
import { signFetch } from '../signing/sign.ts';
import { BlockedDestinationError, safeFetch, type SafeResponse } from './safe-fetch.ts';

// The one way federation reads a document from a peer: an actor, a WebFinger answer, a
// NodeInfo document. It stands where Fedify's document loader would, built on safeFetch so the
// same address predicate guards every fetch (carry-forward finding 2), and it parses plain JSON:
// no JSON-LD expansion, so a peer's @context is never fetched.

/** The shape of safeFetch, for code that takes one so a test can hand it a stub. */
export type Fetcher = typeof safeFetch;

/** Why a document could not be read. `gone` and `not_found` are the peer's answer; `blocked` never retries. */
export class FetchFailure extends Error {
  override readonly name = 'FetchFailure';
  readonly reason: 'blocked' | 'unreachable' | 'not_found' | 'gone' | 'status' | 'not_json' | 'too_large';
  readonly status: number | undefined;

  constructor(reason: FetchFailure['reason'], message: string, status?: number) {
    super(message);
    this.reason = reason;
    this.status = status;
  }
}

const documentLimits = { schemes: ['https:'] as const, maxRedirects: 3, maxBytes: 512 * 1024, timeoutMs: 10_000 };

/** The signature headers for a GET of `url`, or none when the instance has no key to sign with or it will not load. */
async function signatures(url: string): Promise<Headers> {
  try {
    const key = await instanceSigningKey();
    return key ? signFetch(key, url) : new Headers();
  } catch (error) {
    // A fetch that works unsigned is better than none; the delivery side reports a broken key loudly.
    console.warn(`could not sign a fetch of ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return new Headers();
  }
}

export const activityAccept = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

/** An ActivityPub object or actor document: fetched with `Accept: application/activity+json`, signed as the instance. */
export const fetchActivity = (url: string, fetch: Fetcher) => fetchJson(url, fetch, activityAccept, { signed: true });

/**
 * GETs `url` and parses the JSON body. Redirects are followed (each hop checked again) up to
 * three; `url` in the result is where the document finally came from, which is what its id
 * must live under. With `signed` the request carries the instance's HTTP signature, for peers
 * that only answer authenticated fetches (a redirected hop goes out unsigned: safeFetch drops
 * the signature, which vouches for one request).
 */
export async function fetchJson(
  url: string,
  fetch: Fetcher,
  accept = activityAccept,
  { signed = false }: { signed?: boolean } = {},
): Promise<{ json: unknown; url: string }> {
  let response: SafeResponse;
  try {
    const headers = new Headers({ accept, 'user-agent': await userAgent() });
    if (signed) {
      for (const [name, value] of await signatures(url)) headers.set(name, value);
    }
    response = await fetch(url, { ...documentLimits, headers });
  } catch (error) {
    if (error instanceof BlockedDestinationError) throw new FetchFailure('blocked', error.message);
    throw new FetchFailure('unreachable', error instanceof Error ? error.message : String(error));
  }
  if (response.status === 404) throw new FetchFailure('not_found', `${url} answered 404`, 404);
  if (response.status === 410) throw new FetchFailure('gone', `${url} answered 410`, 410);
  if (response.status !== 200) throw new FetchFailure('status', `${url} answered ${response.status}`, response.status);
  // Half a document is no document: a body cut at the cap is refused.
  if (response.truncated) throw new FetchFailure('too_large', `${url} is larger than the document limit`);
  const type = response.headers.get('content-type') ?? '';
  if (!/json/i.test(type)) throw new FetchFailure('not_json', `${url} answered ${type || 'no content type'}`);
  try {
    return { json: JSON.parse(new TextDecoder().decode(response.body)), url: response.url };
  } catch {
    throw new FetchFailure('not_json', `${url} is not JSON`);
  }
}
