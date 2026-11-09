import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { instances } from '@peblish/core/db/tables/instances';
import { truncateAll } from '@peblish/core/testing/db';
import { nodeInfoRoutes, seedLocalInstance, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { cleanSoftware, fetchNodeInfo, refreshInstanceSoftware, softwareFieldMax } from './client.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
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
