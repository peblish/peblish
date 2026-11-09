import { describe, expect, test, vi } from 'vitest';
import type { Fetcher } from '../actors/document.ts';
import { BlockedDestinationError } from '../actors/safe-fetch.ts';
import { limit, maxRequests, windowMs } from './limit.ts';

vi.mock('@peblish/core/resolve/blocked', () => ({
  hostBlocked: async (host: string) => host === 'blocked.test' || host === 'blocked.test:8443',
}));

const init = { schemes: ['https:'] as const, maxRedirects: 0, maxBytes: 1024, timeoutMs: 10_000 };
const answer = { status: 200, headers: new Headers(), body: new Uint8Array(), url: 'https://lemmy.test/' };

function counting() {
  const seen: { url: string; timeoutMs: number }[] = [];
  const inner: Fetcher = async (url, options) => {
    seen.push({ url: String(url), timeoutMs: options.timeoutMs });
    return answer;
  };
  return { inner, seen };
}

describe('the request allowance of one lookup', () => {
  test('lets 12 requests through and refuses the 13th without making it, saying so', async () => {
    const { inner, seen } = counting();
    const guard = limit(inner);
    for (let n = 0; n < maxRequests; n += 1) await guard.fetch(`https://lemmy.test/${n}`, init);
    expect(guard.spent).toBe(false);
    await expect(guard.fetch('https://lemmy.test/13', init)).rejects.toThrow('12 requests in 15 seconds');
    expect(guard.spent).toBe(true);
    expect(guard.used).toBe(maxRequests);
    expect(seen).toHaveLength(maxRequests);
  });

  test('clamps each request’s timeout to the time left and refuses everything once the window is over', async () => {
    const { inner, seen } = counting();
    let clock = 1_000_000;
    const guard = limit(inner, { now: () => clock });
    await guard.fetch('https://lemmy.test/a', init);
    clock += 12_000;
    await guard.fetch('https://lemmy.test/b', init);
    expect(seen.map((request) => request.timeoutMs)).toEqual([10_000, 3_000]);
    clock += 3_000;
    expect(clock - 1_000_000).toBe(windowMs);
    await expect(guard.fetch('https://lemmy.test/c', init)).rejects.toThrow();
    expect(guard.spent).toBe(true);
    expect(seen).toHaveLength(2);
  });

  test('refuses a blocked host by name, with its port, and remembers which', async () => {
    const { inner, seen } = counting();
    const guard = limit(inner);
    await guard.fetch('https://lemmy.test/ok', init);
    await expect(guard.fetch('https://blocked.test/c/lab', init)).rejects.toBeInstanceOf(BlockedDestinationError);
    await expect(guard.fetch('https://blocked.test:8443/c/lab', init)).rejects.toBeInstanceOf(BlockedDestinationError);
    expect(guard.blockedHost).toBe('blocked.test');
    expect(guard.spent).toBe(false);
    expect(guard.used).toBe(1);
    expect(seen).toHaveLength(1);
  });
});
