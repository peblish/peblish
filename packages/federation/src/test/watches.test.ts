import { follows } from '@peblish/core/db/tables/follows';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { localUser, seedActor, seedInstance } from '@peblish/core/testing/seed';
import { outboxEvents, seedPost } from '@peblish/core/testing/seed-az';
import { drainNotices, say } from '@peblish/core/testing/seed-e2';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { unwatchThreadAs, watchThreadAs } from '@peblish/core/watches/watches';
import { parseEvent } from '@peblish/schema/events';
import { expect, test, vi } from 'vitest';
import { drainFederation } from './personal.ts';

// Following a thread is private (lane f-notify): the real follow and unfollow write their local
// events, and every federation consumer, run over them in a world where the community has a
// follower on another server, produces no activity, no delivery and no event. The thread_reply
// notices a followed thread's comment causes add nothing for other servers either: the comment
// itself federates as it always did, and nothing more.

vi.setConfig({ testTimeout: 120_000 });

test('following and unfollowing a thread, and the notices it brings, send nothing to other servers', async () => {
  await truncateAll();
  const { instance } = await seedLocalInstance();
  const alice = await seedActor(instance, 'Person', 'alice');
  const carol = await seedActor(instance, 'Person', 'carol');
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
  await drainFederation();

  const carolAsks = localUser(carol.id);
  expect(await watchThreadAs(carolAsks, { postId: post.id })).toEqual({ ok: true, watching: true });
  expect(await unwatchThreadAs(carolAsks, { postId: post.id })).toEqual({ ok: true, watching: false });
  expect(await watchThreadAs(carolAsks, { postId: post.id })).toEqual({ ok: true, watching: true });
  const watchTypes = (await outboxEvents())
    .map(parseEvent)
    .map((event) => event.type)
    .filter((type) => type.startsWith('watch.'));
  expect(watchTypes).toEqual(['watch.added', 'watch.removed', 'watch.added']);
  expect(await drainFederation()).toEqual({ activities: 0, deliveries: 0, emitted: 0 });

  // A comment in the followed thread: it federates as any comment does (drained here), then its notices do not.
  await say(alice, post.id, 'News for the followers');
  expect((await drainFederation()).deliveries).toBeGreaterThan(0);
  await drainNotices();
  expect((await outboxEvents()).map(parseEvent).filter((event) => event.type === 'notification.created')).toHaveLength(1);
  expect(await drainFederation()).toEqual({ activities: 0, deliveries: 0, emitted: 0 });
});
