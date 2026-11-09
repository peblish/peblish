import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

// THE B2 SEAM. Every outbound request federation makes goes through this module and nothing
// else, so switching to lane B2's shared predicate and fetcher is one change: replace the body
// of this file with
//
//   export { BlockedDestinationError, safeFetch } from '@peblish/core/net/fetch';
//   export type { SafeFetchInit, SafeResponse } from '@peblish/core/net/fetch';
//
// and delete safe-fetch.test.ts. The names and shapes below are the contract B2's brief fixes.
// Until B2's commit is merged, this stand-in is the spike's reviewed guard (spikes/
// fedify-threadiverse/src/safe-post.ts) behind that contract: the host is resolved once and
// every address must be public, the checked address is the one connected to (no rebinding
// window), redirects are followed only as far as `maxRedirects` allows, and time and size
// are capped. There is no switch that lets a private address through.

export type SafeFetchInit = {
  method?: 'GET' | 'POST';
  headers?: HeadersInit;
  body?: string | Uint8Array;
  schemes: readonly ('https:' | 'http:')[];
  /** Each hop is resolved and checked again; 0 for federation delivery. */
  maxRedirects: number;
  /** Response body cap. */
  maxBytes: number;
  timeoutMs: number;
};
export type SafeResponse = { status: number; headers: Headers; body: Uint8Array; url: string };

/** A refused destination: permanent, a caller never retries it. */
export class BlockedDestinationError extends Error {}

// IANA special-purpose registries (RFC 6890 and updates). Node's BlockList tests an IPv4
// address against IPv6 rules through its mapped form, so IPv4-mapped IPv6 addresses are
// unmapped and judged as IPv4 (see classify), and no ::ffff:0:0/96 rule is listed.
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');

/** The address's family, with an IPv4-mapped IPv6 address reduced to the IPv4 inside it. */
function classify(address: string): { address: string; type: 'ipv4' | 'ipv6' } | null {
  const family = isIP(address);
  if (family === 4) return { address, type: 'ipv4' };
  if (family !== 6) return null;
  // The URL parser gives every spelling of a mapped address one form, ::ffff:xxxx:xxxx.
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(new URL(`http://[${address.replace(/%.*$/, '')}]`).hostname);
  if (!mapped) return { address, type: 'ipv6' };
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return { address: `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, type: 'ipv4' };
}

function isPublicAddress(address: string): boolean {
  const ip = classify(address);
  return ip !== null && !blocked.check(ip.address, ip.type);
}

/** dns.lookup that refuses when any address of the host is not public. */
const guardedLookup: typeof lookup = ((hostname: string, options: unknown, callback: unknown) => {
  const done = (typeof options === 'function' ? options : callback) as (
    error: Error | null,
    address?: string | { address: string; family: number }[],
    family?: number,
  ) => void;
  const wantsAll = typeof options === 'object' && options !== null && 'all' in options && options.all === true;
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return done(error);
    const bad = addresses.find((entry) => !isPublicAddress(entry.address));
    if (bad || addresses.length === 0) {
      return done(new BlockedDestinationError(`${hostname} resolves to a blocked address ${bad?.address ?? '(none)'}`));
    }
    if (wantsAll) return done(null, addresses);
    done(null, addresses[0]!.address, addresses[0]!.family);
  });
}) as typeof lookup;

function once(target: URL, init: SafeFetchInit): Promise<SafeResponse> {
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw new BlockedDestinationError(`blocked address ${host}`);
  const headers = Object.fromEntries(new Headers(init.headers));
  const body = typeof init.body === 'string' ? Buffer.from(init.body) : init.body;
  if (body) headers['content-length'] = String(body.byteLength);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<SafeResponse>((resolve, reject) => {
    const req = send(target, { method: init.method ?? 'GET', headers, lookup: guardedLookup }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= init.maxBytes) chunks.push(chunk);
        else res.destroy();
      });
      const settle = () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) responseHeaders.append(name, item);
        }
        resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body: new Uint8Array(Buffer.concat(chunks)), url: target.href });
      };
      res.on('end', settle);
      res.on('close', settle);
    });
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${init.timeoutMs} ms`)), init.timeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}

export async function safeFetch(url: string | URL, init: SafeFetchInit): Promise<SafeResponse> {
  let target = new URL(url);
  for (let hop = 0; ; hop++) {
    if (!init.schemes.includes(target.protocol as 'https:' | 'http:')) {
      throw new BlockedDestinationError(`refusing ${target.protocol} URL ${target.href}`);
    }
    if (target.username || target.password) throw new BlockedDestinationError(`refusing credentials in ${target.host}`);
    const response = await once(target, init);
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location || hop >= init.maxRedirects) return response;
    target = new URL(location, target);
  }
}
