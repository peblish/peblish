import type { Fetcher } from '../actors/document.ts';
import { assertFederationOn } from '../actors/federation-switch.ts';
import { remoteTtls } from './ttl.ts';

// Politeness toward peers we read in bulk (the backfill, the missing-object fetch): one request
// at a time to a host, and a gap after each. The queues are per process, on globalThis because
// the web build can hold two copies of a module; one worker runs the jobs, so that is one
// request at a time to a host for the instance.

type Lane = { tail: Promise<void>; lastEnd: number };
const lanes = ((globalThis as { __peblishPoliteHosts?: Map<string, Lane> }).__peblishPoliteHosts ??= new Map());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `base`, with requests to each host taken in turn and `gapMs` apart. A request whose turn comes
 * while the federation switch is off is not sent: it rejects with FederationPaused.
 */
export function polite(base: Fetcher, gapMs: number = remoteTtls.politeGapMs): Fetcher {
  return async (url, init) => {
    const host = new URL(String(url)).host;
    const lane = lanes.get(host) ?? { tail: Promise.resolve(), lastEnd: 0 };
    lanes.set(host, lane);
    const turn = lane.tail.then(async () => {
      const wait = lane.lastEnd + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      // The switch may have been turned off while this request waited its turn: then it is not sent.
      await assertFederationOn();
      try {
        return await base(url, init);
      } finally {
        lane.lastEnd = Date.now();
      }
    });
    // The next request waits for this one to end, however it ends.
    lane.tail = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  };
}
