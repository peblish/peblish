import { userAgent } from '../federation.ts';
import { instanceSigningKey } from '../signing/instance.ts';
import { signFetch } from '../signing/sign.ts';
import { assertFederationOn, FederationPaused } from './federation-switch.ts';
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

const documentLimits = { schemes: ['https:'] as const, maxBytes: 512 * 1024, timeoutMs: 10_000 };
const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

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

/** A document read from a peer: `url` is where it finally came from and `hops` the redirects followed to get there. */
export type FetchedDocument = { json: unknown; url: string; hops: number };

/**
 * An ActivityPub object or actor document: fetched with `Accept: application/activity+json`,
 * signed as the instance. No redirect is followed unless the caller allows some: an actor
 * document may move (the caller passes 3), a collection or an object is where its id says.
 */
export const fetchActivity = (url: string, fetch: Fetcher, { maxRedirects = 0 }: { maxRedirects?: number } = {}) =>
  fetchJson(url, fetch, activityAccept, { signed: true, maxRedirects });

/**
 * GETs `url` and parses the JSON body. Up to `maxRedirects` redirects are followed here, one
 * request each through `fetch` (so every hop is resolved and checked again by safeFetch, and a
 * caller that counts requests counts them), and `hops` says how many were followed; `url` in the
 * result is where the document finally came from, which is what its id must live under. With
 * `signed` the first request carries the instance's HTTP signature, for peers that only answer
 * authenticated fetches; a redirected hop goes out unsigned, as the signature vouches for one
 * request. The whole read has one deadline. WebFinger and NodeInfo keep three redirects. The
 * federation switch is read before each request, redirect hops included, once its headers are
 * ready: while it is off this throws FederationPaused and sends nothing more (federation-switch.ts).
 */
export async function fetchJson(
  url: string,
  fetch: Fetcher,
  accept = activityAccept,
  { signed = false, maxRedirects = 3 }: { signed?: boolean; maxRedirects?: number } = {},
): Promise<FetchedDocument> {
  const deadline = Date.now() + documentLimits.timeoutMs;
  let target = url;
  let hops = 0;
  let response: SafeResponse;
  for (;;) {
    const headers = new Headers({ accept, 'user-agent': await userAgent() });
    if (signed && hops === 0) {
      for (const [name, value] of await signatures(target)) headers.set(name, value);
    }
    // Read last, after the waits above (the signing key is a database read), before every request,
    // each redirect hop included, and outside the try below, which would make it a peer's failure.
    await assertFederationOn();
    try {
      response = await fetch(target, { ...documentLimits, maxRedirects: 0, timeoutMs: Math.max(1, deadline - Date.now()), headers });
    } catch (error) {
      // A fetcher with a wait of its own checks the switch again after it (remote-fetch/polite.ts,
      // the inbound pipeline's lease renewal, the held-signer lookup, a search's block check).
      if (error instanceof FederationPaused) throw error;
      if (error instanceof BlockedDestinationError) throw new FetchFailure('blocked', error.message);
      throw new FetchFailure('unreachable', error instanceof Error ? error.message : String(error));
    }
    const location = response.headers.get('location');
    if (!redirectStatuses.has(response.status) || location === null || hops >= maxRedirects) break;
    try {
      target = new URL(location, response.url).href;
    } catch {
      throw new FetchFailure('status', `${response.url} redirected to something that is not a URL`, response.status);
    }
    hops++;
  }
  if (response.status === 404) throw new FetchFailure('not_found', `${url} answered 404`, 404);
  if (response.status === 410) throw new FetchFailure('gone', `${url} answered 410`, 410);
  if (response.status !== 200) throw new FetchFailure('status', `${url} answered ${response.status}`, response.status);
  // Half a document is no document: a body cut at the cap is refused.
  if (response.truncated) throw new FetchFailure('too_large', `${url} is larger than the document limit`);
  const type = response.headers.get('content-type') ?? '';
  if (!/json/i.test(type)) throw new FetchFailure('not_json', `${url} answered ${type || 'no content type'}`);
  try {
    return { json: JSON.parse(new TextDecoder().decode(response.body)), url: response.url, hops };
  } catch {
    throw new FetchFailure('not_json', `${url} is not JSON`);
  }
}
