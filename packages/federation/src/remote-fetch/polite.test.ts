import { describe, expect, test } from 'vitest';
import type { Fetcher } from '../actors/document.ts';
import { polite } from './polite.ts';

const init = { schemes: ['https:'], maxRedirects: 0, maxBytes: 1024, timeoutMs: 1000 } as const;

/** A fetcher that takes `ms` to answer, noting when each request starts and how many run at once. */
function slow(ms: number) {
  const log: { url: string; start: number }[] = [];
  const running = new Set<string>();
  let peak = 0;
  const peakByHost = new Map<string, number>();
  const fetch = (async (url: string | URL) => {
    const href = String(url);
    const host = new URL(href).host;
    log.push({ url: href, start: Date.now() });
    running.add(href);
    peak = Math.max(peak, running.size);
    const sameHost = [...running].filter((other) => new URL(other).host === host).length;
    peakByHost.set(host, Math.max(peakByHost.get(host) ?? 0, sameHost));
    await new Promise((resolve) => setTimeout(resolve, ms));
    running.delete(href);
    return { status: 200, headers: new Headers(), body: new Uint8Array(), url: href };
  }) as Fetcher;
  return { fetch, log, peak: () => peak, peakByHost };
}

describe('polite fetching', () => {
  test('takes requests to one host in turn, in order, and lets other hosts through meanwhile', async () => {
    const peer = slow(15);
    const fetch = polite(peer.fetch, 0);
    await Promise.all([
      fetch('https://a.test/1', init),
      fetch('https://a.test/2', init),
      fetch('https://a.test/3', init),
      fetch('https://b.test/1', init),
      fetch('https://c.test/1', init),
    ]);
    expect(peer.peakByHost.get('a.test')).toBe(1);
    expect(peer.peak()).toBeGreaterThan(1);
    expect(peer.log.filter((entry) => entry.url.startsWith('https://a.test')).map((entry) => entry.url)).toEqual([
      'https://a.test/1',
      'https://a.test/2',
      'https://a.test/3',
    ]);
  });

  test('leaves a gap after each request, and a failed request does not block the next', async () => {
    const calls: number[] = [];
    const base = (async (url: string | URL) => {
      calls.push(Date.now());
      if (String(url).endsWith('/fails')) throw new Error('down');
      return { status: 200, headers: new Headers(), body: new Uint8Array(), url: String(url) };
    }) as Fetcher;
    const fetch = polite(base, 40);
    const results = await Promise.allSettled([
      fetch('https://gap.test/fails', init),
      fetch('https://gap.test/next', init),
      fetch('https://gap.test/last', init),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    // Timers may fire a millisecond early; the gap is 40.
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(35);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(35);
  });
});
