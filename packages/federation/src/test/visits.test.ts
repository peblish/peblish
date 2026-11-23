import { follows } from '@peblish/core/db/tables/follows';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, localUser, seedInstance } from '@peblish/core/testing/seed';
import { seedPost } from '@peblish/core/testing/seed-az';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { recordVisitAs } from '@peblish/core/visits/visits';
import { beforeEach, expect, test } from 'vitest';
import { drainFederation } from './personal.ts';

// A visit to a thread stays on this server: recording one, through the real entry point, gives
// the federation consumers nothing to send, even for a post in a community followed from elsewhere.

let record: () => ReturnType<typeof recordVisitAs>;

beforeEach(async () => {
  await truncateAll();
  const { instance } = await seedLocalInstance();
  const alice = await seedActor(instance, 'Person', 'alice');
  const news = await seedActor(instance, 'Group', 'news', { inboxUrl: 'https://fed-a.test/ap/c.news/inbox' });
  await seedSigningKey(alice);
  await seedSigningKey(news);
  const peer = await seedInstance('lemmy.test', false);
  const bob = await seedActor(peer, 'Person', 'bob', {
    inboxUrl: 'https://lemmy.test/u/bob/inbox',
    sharedInboxUrl: 'https://lemmy.test/inbox',
  });
  await writer()
    .insert(follows)
    .values({ followerId: bob.id, followeeId: news.id, apId: 'https://lemmy.test/follow/bob', state: 'accepted', acceptedAt: new Date() });
  const post = await seedPost(instance, news, alice);
  record = () => recordVisitAs(localUser(alice.id), { postId: post.id });
  await drainFederation();
});

test('recording a visit sends nothing to other servers', async () => {
  expect(await record()).toEqual({ ok: true, recorded: true });
  expect(await drainFederation()).toEqual({ activities: 0, deliveries: 0, emitted: 0 });
});
