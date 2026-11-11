import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { instances } from '@peblish/core/db/tables/instances';
import { truncateAll } from '@peblish/core/testing/db';
import { nodeInfoRoutes, seedLocalInstance, stubFetch } from '@peblish/core/testing/seed-fed-a';
import {
  cleanSoftware,
  fetchNodeInfo,
  forgetNodeInfoFailures,
  nodeInfoFailureCount,
  nodeInfoRetryMs,
  refreshInstanceSoftware,
  softwareFieldMax,
} from './client.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
  forgetNodeInfoFailures();
});

describe('the software a peer names', () => {
  test('is lowercased and kept as NodeInfo writes it', () => {
    expect(cleanSoftware('Lemmy', '0.19.21')).toEqual({ software: 'lemmy', version: '0.19.21' });
    expect(cleanSoftware('piefed', undefined)).toEqual({ software: 'piefed', version: null });
    expect(cleanSoftware('mastodon', '4.4.0+glitch')).toEqual({ software: 'mastodon', version: '4.4.0+glitch' });
  });

  test('loses what NodeInfo’s name pattern and a printable version do not allow, and is cut at the cap', () => {
    expect(cleanSoftware('Evil Soft/<script>', ' 1.0\u0000\u202e\n ')).toEqual({ software: 'evilsoftscript', version: '1.0' });
    const long = cleanSoftware('a'.repeat(500), 'v'.repeat(500));
    expect(long.software).toHaveLength(softwareFieldMax);
    expect(long.version).toHaveLength(softwareFieldMax);
    expect(cleanSoftware('lemmy', '   ').version).toBeNull();
  });

  test('must leave a name', () => {
    expect(() => cleanSoftware('日本語', '1')).toThrow(/no usable software/);
    expect(() => cleanSoftware('', '1')).toThrow(/no usable software/);
  });

  test('is cleaned on its way from the document to the instance row', async () => {
    const { fetch } = stubFetch(nodeInfoRoutes('peer.test', `Big-${'x'.repeat(400)}`, `1.${'9'.repeat(400)}`));
    expect(await fetchNodeInfo('https://peer.test', fetch)).toEqual({
      software: `big-${'x'.repeat(softwareFieldMax - 4)}`,
      version: `1.${'9'.repeat(softwareFieldMax - 2)}`,
    });
    await refreshInstanceSoftware('https://peer.test', { fetch });
    const [row] = await db().select().from(instances).where(eq(instances.domain, 'peer.test'));
    expect(row?.software).toHaveLength(softwareFieldMax);
    expect(row?.softwareVersion).toHaveLength(softwareFieldMax);
  });
});

describe('refreshing an instance’s software', () => {
  const software = async (domain: string) => (await db().select().from(instances).where(eq(instances.domain, domain)))[0]?.software;

  test('callers that arrive while a read is running share it', async () => {
    const { fetch, requests } = stubFetch(nodeInfoRoutes('peer.test', 'lemmy'));
    await Promise.all(Array.from({ length: 5 }, () => refreshInstanceSoftware('https://peer.test', { fetch })));
    expect(requests.filter((request) => request.url.endsWith('/.well-known/nodeinfo'))).toHaveLength(1);
    expect(await software('peer.test')).toBe('lemmy');
  });

  test('a failed check is not repeated for ten minutes, then is, and a success clears it', async () => {
    const down = stubFetch({});
    const t0 = Date.now();
    await refreshInstanceSoftware('https://peer.test', { fetch: down.fetch, now: t0 });
    await refreshInstanceSoftware('https://peer.test', { fetch: down.fetch, now: t0 + nodeInfoRetryMs - 1 });
    expect(down.requests).toHaveLength(1);
    expect(nodeInfoFailureCount()).toBe(1);

    const up = stubFetch(nodeInfoRoutes('peer.test', 'piefed'));
    await refreshInstanceSoftware('https://peer.test', { fetch: up.fetch, now: t0 + nodeInfoRetryMs });
    expect(await software('peer.test')).toBe('piefed');
    expect(nodeInfoFailureCount()).toBe(0);
  });

  test('expired entries are forgotten as new failures arrive, and the map stays bounded', async () => {
    const down = stubFetch({});
    const t0 = Date.now();
    for (const host of ['a.test', 'b.test', 'c.test']) await refreshInstanceSoftware(`https://${host}`, { fetch: down.fetch, now: t0 });
    expect(nodeInfoFailureCount()).toBe(3);
    await refreshInstanceSoftware('https://d.test', { fetch: down.fetch, now: t0 + nodeInfoRetryMs });
    expect(nodeInfoFailureCount()).toBe(1);

    for (let batch = 0; batch < 51; batch++) {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          refreshInstanceSoftware(`https://flood${batch * 100 + i}.test`, { fetch: down.fetch, now: t0 + nodeInfoRetryMs + 1 }),
        ),
      );
    }
    expect(nodeInfoFailureCount()).toBeLessThanOrEqual(5_000);
    // 5,100 failing refreshes, each logged, outlast the 5 s default on a slow CI runner (PR #10); the bound is the assertion above.
  }, 60_000);
});
