import { userAgent } from '../federation.ts';
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

export const activityAccept = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

/**
 * GETs `url` and parses the JSON body. Redirects are followed (each hop checked again) up to
 * three; `url` in the result is where the document finally came from, which is what its id
 * must live under.
 */
export async function fetchJson(url: string, fetch: Fetcher, accept = activityAccept): Promise<{ json: unknown; url: string }> {
  let response: SafeResponse;
  try {
    response = await fetch(url, { ...documentLimits, headers: { accept, 'user-agent': await userAgent() } });
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
