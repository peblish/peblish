import { lookup as resolveHost } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicAddress } from './public-address.ts';

// The one outbound HTTP client for hosts that a person or a peer chose: federation delivery
// and fetches, link previews, the remote-media proxy. It resolves the host once, requires
// every address to be public, and connects to those checked addresses (the pinned `lookup`
// below), so DNS cannot answer differently between the check and the connection. TLS and the
// Host header still use the original host name. Redirects are followed by this function, each
// hop through the same checks; the platform fetch is never used for such a host.

export type SafeFetchInit = {
  method?: 'GET' | 'POST';
  /** Sent as given, minus the headers that identify a viewer or break the framing (see `forbidden`). */
  headers?: HeadersInit;
  body?: string | Uint8Array;
  schemes: readonly ('https:' | 'http:')[];
  /** Each hop is resolved and checked again; 0 for federation delivery (a 3xx is then returned as is). */
  maxRedirects: number;
  /** Response body cap: the body is cut there and `truncated` is set. */
  maxBytes: number;
  /** One deadline for the whole call: every lookup, redirect and the body. */
  timeoutMs: number;
};

export type SafeResponse = {
  status: number;
  headers: Headers;
  body: Uint8Array;
  /** The URL of the last hop. */
  url: string;
  /** True when the body was cut at `maxBytes`: a caller that cannot use half a body refuses it. */
  truncated?: true;
};

/** A destination safeFetch refuses: permanent, so a caller never retries it. */
export class BlockedDestinationError extends Error {}

/** The call outran `timeoutMs`; transient. */
export class FetchTimeoutError extends Error {}

/** How a host name becomes addresses, and which addresses may be connected to. */
export type FetchDeps = {
  resolve(hostname: string): Promise<readonly string[]>;
  isPublic(address: string): boolean;
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Headers that name the viewer behind a request or that this module sets itself. A caller
 * cannot pass them on, whether it means to or not.
 */
const forbidden = new Set([
  'cookie',
  'cookie2',
  'referer',
  'origin',
  'authorization',
  'proxy-authorization',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'via',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'expect',
]);

function outgoingHeaders(init: HeadersInit | undefined): Record<string, string> {
  const headers = new Headers(init);
  for (const name of forbidden) headers.delete(name);
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');
  return Object.fromEntries(headers);
}

function without(headers: Record<string, string>, ...names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name)));
}

/** Rejects with the signal's reason when it fires first; the work behind `promise` is left to finish. */
function before<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    promise.then(resolve, reject);
  });
}

function parseTarget(raw: string | URL, schemes: SafeFetchInit['schemes'], base?: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new BlockedDestinationError(`not a URL: ${String(raw).slice(0, 200)}`);
  }
  if (!(schemes as readonly string[]).includes(url.protocol)) throw new BlockedDestinationError(`${url.protocol} is not allowed here`);
  if (url.username || url.password) throw new BlockedDestinationError('URLs with credentials are refused');
  return url;
}

/** The addresses a hop may connect to: the host's, every one of them public. */
async function checkedAddresses(url: URL, deps: FetchDeps, signal: AbortSignal): Promise<string[]> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : [...(await before(signal, deps.resolve(host)))];
  if (addresses.length === 0) throw new Error(`${host} did not resolve to an address`);
  const blocked = addresses.find((address) => !deps.isPublic(address));
  if (blocked !== undefined) throw new BlockedDestinationError(`${host} is not a public destination (${blocked})`);
  return addresses;
}

type Hop = { status: number; headers: Headers; body: Uint8Array; truncated: boolean };

/** One request to the checked addresses. */
function requestOnce(
  url: URL,
  addresses: readonly string[],
  request: { method: string; headers: Record<string, string>; body: Buffer | undefined },
  maxBytes: number,
  signal: AbortSignal,
): Promise<Hop> {
  const pinned = addresses.map((address) => ({ address, family: isIP(address) }));
  // Node asks for one address, or for all of them when it tries IPv6 and IPv4 in turn.
  const lookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, pinned);
    else callback(null, pinned[0]!.address, pinned[0]!.family);
  };
  const send = url.protocol === 'https:' ? https.request : http.request;
  return new Promise<Hop>((resolve, reject) => {
    const headers = request.body ? { ...request.headers, 'content-length': String(request.body.length) } : request.headers;
    const req = send(url, { method: request.method, headers, agent: false, lookup, signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      const finish = (truncated: boolean) => {
        finished = true;
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const each of value) headers.append(name, each);
          else if (value !== undefined) headers.set(name, value);
        }
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated });
        if (truncated) res.destroy();
      };
      res.on('data', (chunk: Buffer) => {
        if (finished) return;
        const room = maxBytes - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += Math.min(chunk.length, room);
        if (chunk.length > room) finish(true);
      });
      res.on('end', () => !finished && finish(false));
      res.on('error', reject);
      res.on('close', () => !finished && reject(new Error('the connection closed before the response ended')));
    });
    req.on('error', reject);
    req.end(request.body);
  });
}

/**
 * safeFetch's implementation with its resolver and address check as parameters. Product code
 * never imports this: it uses `safeFetch`. A test that needs a stub server on a private address
 * passes its own `isPublic` (and a `resolve` that answers from a table); fetch.test.ts checks
 * that nothing else imports it.
 */
export function createSafeFetch(deps: FetchDeps) {
  return async function safeFetch(url: string | URL, init: SafeFetchInit): Promise<SafeResponse> {
    const signal = AbortSignal.timeout(init.timeoutMs);
    let target = parseTarget(url, init.schemes);
    let method: string = init.method ?? 'GET';
    let body = init.body === undefined ? undefined : Buffer.from(init.body);
    let headers = outgoingHeaders(init.headers);
    try {
      for (let redirects = 0; ; redirects++) {
        const addresses = await checkedAddresses(target, deps, signal);
        const hop = await requestOnce(target, addresses, { method, headers, body }, init.maxBytes, signal);
        const location = hop.headers.get('location');
        if (!REDIRECTS.has(hop.status) || location === null || redirects >= init.maxRedirects) {
          return {
            status: hop.status,
            headers: hop.headers,
            body: hop.body,
            url: target.href,
            ...(hop.truncated && { truncated: true as const }),
          };
        }
        target = parseTarget(location, init.schemes, target);
        // A signature and digest vouch for the one request they were made for.
        headers = without(headers, 'signature', 'digest');
        if (hop.status !== 307 && hop.status !== 308) {
          // Browsers turn the POST of a 301, 302 or 303 into a GET without the body.
          method = 'GET';
          body = undefined;
          headers = without(headers, 'content-type');
        }
      }
    } catch (error) {
      if (signal.aborted) throw new FetchTimeoutError(`no complete answer within ${init.timeoutMs} ms`);
      throw error;
    }
  };
}

/** Fetches a URL a person or a peer chose; see the module comment and SafeFetchInit. */
export const safeFetch = createSafeFetch({
  async resolve(hostname) {
    return (await resolveHost(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  },
  isPublic: isPublicAddress,
});
