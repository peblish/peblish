import { writer } from '@peblish/core/db/write';
import { follows } from '@peblish/core/db/tables/follows';
import { savePostAs, unsavePostAs } from '@peblish/core/saves/saves';
import { truncateAll } from '@peblish/core/testing/db';
import { outboxEvents, seedPost } from '@peblish/core/testing/seed-az';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { person, seedPerson } from '@peblish/core/testing/seed-f';
import { beforeEach, expect, test } from 'vitest';
import { drainFederation } from './personal.ts';

// Saves stay on this server: a save and an unsave through the real entry points write their local
// events, and every federation consumer then adds no activity, no delivery and no event, even for a
// post in a community another server follows.

beforeEach(truncateAll);

test('saving and unsaving a post sends nothing to other servers', async () => {
  const { instance } = await seedLocalInstance();
  const ann = await seedPerson(instance, 'ann');
  const news = await seedActor(instance, 'Group', 'news', { inboxUrl: 'https://fed-a.test/ap/c.news/inbox' });
  await seedSigningKey(ann);
  await seedSigningKey(news);
  const peer = await seedInstance('lemmy.test', false);
  const bob = await seedActor(peer, 'Person', 'bob', {
    inboxUrl: 'https://lemmy.test/u/bob/inbox',
    sharedInboxUrl: 'https://lemmy.test/inbox',
  });
  await writer()
    .insert(follows)
    .values({ followerId: bob.id, followeeId: news.id, apId: 'https://lemmy.test/follow/bob', state: 'accepted', acceptedAt: new Date() });
  const post = await seedPost(instance, news, ann);
  await drainFederation();

  expect(await savePostAs(person(ann.id), { postId: post.id })).toEqual({ ok: true, saved: true });
  expect(await unsavePostAs(person(ann.id), { postId: post.id })).toEqual({ ok: true, saved: false });
  // The events are there, so the drain below has something to ignore.
  expect((await outboxEvents()).map((event) => (event as { type: string }).type)).toEqual(['save.added', 'save.removed']);
  expect(await drainFederation()).toEqual({ activities: 0, deliveries: 0, emitted: 0 });
});
