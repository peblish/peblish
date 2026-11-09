import { hostBlocked } from '@peblish/core/resolve/blocked';
import { BlockedDestinationError } from '../actors/safe-fetch.ts';
import type { Fetcher } from '../actors/document.ts';

// What one lookup may ask of the network. A person typing a handle makes this server fetch
// addresses of their choosing, and a peer's documents point on to more (redirects, a community,
// an author, a parent comment), so the whole lookup shares one allowance: 12 requests inside 15
// seconds, each one's timeout clamped to what is left. The fetchers beneath turn any error into
// `unreachable` or `blocked` (actors/document.ts), so the reasons for a refusal are kept here as
// flags for the caller to read once something failed.

export const maxRequests = 12;
export const windowMs = 15_000;

export type Limited = {
  fetch: Fetcher;
  /** The allowance ran out: a request was refused for its count or for the time. */
  readonly spent: boolean;
  /** The blocked host a request was refused for, redirects and the community's host included. */
  readonly blockedHost: string | null;
  /** Requests let through so far. */
  readonly used: number;
};

/** Wraps `inner` in one lookup's allowance, and refuses any host `hostBlocked` names. */
export function limit(inner: Fetcher, { now = Date.now }: { now?: () => number } = {}): Limited {
  const began = now();
  let used = 0;
  let spent = false;
  let blockedHost: string | null = null;
  const fetch: Fetcher = async (url, init) => {
    const left = windowMs - (now() - began);
    if (used >= maxRequests || left <= 0) {
      spent = true;
      throw new Error(`a lookup may make ${maxRequests} requests in ${windowMs / 1000} seconds`);
    }
    // A host is blocked by the name it is asked under, before any address is looked up.
    const host = new URL(url).host;
    if (await hostBlocked(host)) {
      blockedHost ??= host;
      throw new BlockedDestinationError(`${host} is a blocked instance`);
    }
    used += 1;
    return inner(url, { ...init, timeoutMs: Math.min(init.timeoutMs, left) });
  };
  return {
    fetch,
    get spent() {
      return spent;
    },
    get blockedHost() {
      return blockedHost;
    },
    get used() {
      return used;
    },
  };
}
