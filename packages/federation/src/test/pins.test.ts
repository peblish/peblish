import { writer } from '@peblish/core/db/write';
import { follows } from '@peblish/core/db/tables/follows';
import { outboxEvents } from '@peblish/core/testing/seed-az';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { movePinAs, pinCommunityAs, unpinCommunityAs } from '@peblish/core/pins/pins';
import { beforeEach, expect, test } from 'vitest';
import { drainFederation } from './personal.ts';

// Sidebar pins stay on this server: pinning, moving and unpinning through the real entry points
// writes their events, and no federation consumer turns them into anything another server
// receives, though the communities have followers there.

beforeEach(truncateAll);

test('pinning, moving and unpinning reach no other server', async () => {
  const { instance } = await seedLocalInstance();
  const alice = await seedActor(instance, 'Person', 'alice');
  const peer = await seedInstance('lemmy.test', false);
  const bob = await seedActor(peer, 'Person', 'bob', {
    inboxUrl: 'https://lemmy.test/u/bob/inbox',
    sharedInboxUrl: 'https://lemmy.test/inbox',
  });
  const communities = [];
  for (const name of ['news', 'art']) {
    const community = await seedActor(instance, 'Group', name, { inboxUrl: `https://fed-a.test/ap/c.${name}/inbox` });
    await seedSigningKey(community);
    await writer()
      .insert(follows)
      .values([
        {
          followerId: bob.id,
          followeeId: community.id,
          apId: `https://lemmy.test/follow/${name}`,
          state: 'accepted',
          acceptedAt: new Date(),
        },
        { followerId: alice.id, followeeId: community.id, state: 'accepted', acceptedAt: new Date() },
      ]);
    communities.push(community);
  }
  const [news, art] = communities as [(typeof communities)[0], (typeof communities)[0]];
  await drainFederation();

  const me = { kind: 'local', actorId: alice.id, siteRole: 'user' } as const;
  expect(await pinCommunityAs(me, { communityId: news.id })).toMatchObject({ ok: true });
  expect(await pinCommunityAs(me, { communityId: art.id })).toMatchObject({ ok: true });
  expect(await movePinAs(me, { communityId: art.id, toPosition: 0 })).toMatchObject({ ok: true });
  expect(await unpinCommunityAs(me, { communityId: news.id })).toMatchObject({ ok: true });
  expect((await outboxEvents()).map((event) => (event as { type: string }).type)).toEqual([
    'pin.added',
    'pin.added',
    'pin.moved',
    'pin.removed',
  ]);
  expect(await drainFederation()).toEqual({ activities: 0, deliveries: 0, emitted: 0 });
});
