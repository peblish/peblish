import { beforeEach, expect, test, vi } from 'vitest';
import { parseLookup } from '@peblish/core/resolve/parse';
import { truncateAll } from '@peblish/core/testing/db';
import { actorDocument, nodeInfoRoutes, rsaKeys, seedLocalInstance, stubFetch, webfingerAnswer } from '@peblish/core/testing/seed-fed-a';
import { forgetNodeInfoFailures } from '../nodeinfo/client.ts';
import { lemmy, lemmyPage } from '../remote-fetch/test-support.ts';
import { resolveLookup } from './web.ts';

// MODF's block seam, swapped for a list: blocked.test is blocked.
vi.mock('@peblish/core/resolve/blocked', () => ({
  hostBlocked: async (host: string) => host === 'blocked.test',
  blockedHosts: async () => ['blocked.test'],
}));

const { publicKeyPem } = rsaKeys();
const lookup = (text: string) => parseLookup(text)!;

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance('disc.test');
  forgetNodeInfoFailures();
});

test('a blocked host is refused as instance.blocked whether it is asked for, redirected to, or the community’s home', async () => {
  const blockedLab = actorDocument('blocked.test', 'lab', { kind: 'Group', publicKeyPem });
  const lemmyUser = actorDocument('lemmy.test', 'lemmyuser', { publicKeyPem });
  const peer = stubFetch({
    // Asked for directly: no request at all.
    [blockedLab.id]: { body: blockedLab },
    // Redirected to.
    'https://lemmy.test/moved': { status: 301, location: blockedLab.id, body: '' },
    // A post that names a community on the blocked host.
    [`${lemmy}/post/1`]: { body: lemmyPage(1, { audience: blockedLab.id, to: [blockedLab.id] }) },
    [lemmyUser.id]: { body: lemmyUser },
    'https://blocked.test/.well-known/webfinger?resource=acct%3Alab%40blocked.test': {
      type: 'application/jrd+json',
      body: webfingerAnswer('acct:lab@blocked.test', [{ href: blockedLab.id, type: 'Group' }]),
    },
    ...nodeInfoRoutes('lemmy.test', 'lemmy'),
  });
  expect(await resolveLookup(lookup('!lab@blocked.test'), { fetch: peer.fetch })).toEqual({ ok: false, error: 'instance.blocked' });
  expect(await resolveLookup(lookup(blockedLab.id), { fetch: peer.fetch })).toEqual({ ok: false, error: 'instance.blocked' });
  expect(await resolveLookup(lookup('https://lemmy.test/moved'), { fetch: peer.fetch })).toEqual({ ok: false, error: 'instance.blocked' });
  expect(await resolveLookup(lookup(`${lemmy}/post/1`), { fetch: peer.fetch })).toEqual({ ok: false, error: 'instance.blocked' });
  expect(peer.requests.filter((request) => new URL(request.url).host === 'blocked.test')).toEqual([]);
});
