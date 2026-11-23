import { db } from '@peblish/core/db/read';
import { activities } from '@peblish/core/db/tables/federation';
import { follows } from '@peblish/core/db/tables/follows';
import { outbox } from '@peblish/core/db/tables/outbox';
import { writer } from '@peblish/core/db/write';
import { deliveries } from '@peblish/core/delivery/tables';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { seedPost } from '@peblish/core/testing/seed-az';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { tx } from '@peblish/core/tx/tx';
import type { OutboxEvent } from '@peblish/schema/events';
import { personalEventTypes, type PersonalEventType } from '@peblish/schema/personal';
import { beforeEach, expect, test } from 'vitest';
import { consumer as delivery } from '../delivery/consumer.ts';
import { drainFederation } from './personal.ts';

// The personal features' events stay on this server: every federation consumer, run through the
// worker, adds no activity, no delivery and no event for any of them, even for a post in a
// community with followers on another server (where a post's own events would be announced).

type Personal = { [K in PersonalEventType]: Extract<OutboxEvent, { type: K }> };

let events: Personal;
let created: Extract<OutboxEvent, { type: 'post.created' }>;

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
  created = { type: 'post.created', v: 1, postId: post.id, communityId: news.id, authorId: alice.id, local: true };
  const owner = { v: 1, ownerId: alice.id } as const;
  events = {
    'save.added': { type: 'save.added', ...owner, postId: post.id },
    'save.removed': { type: 'save.removed', ...owner, postId: post.id },
    'pin.added': { type: 'pin.added', ...owner, communityId: news.id, position: 0 },
    'pin.removed': { type: 'pin.removed', ...owner, communityId: news.id, position: 0 },
    'pin.moved': { type: 'pin.moved', ...owner, communityId: news.id, from: 0, to: 1 },
    'watch.added': { type: 'watch.added', ...owner, postId: post.id },
    'watch.removed': { type: 'watch.removed', ...owner, postId: post.id },
    'visit.recorded': { type: 'visit.recorded', ...owner, postId: post.id },
  };
  // The seeds write no events; drain anyway so each test counts only what its event caused.
  await drainFederation();
});

test('control: in the same world the post itself is announced to the follower', async () => {
  await tx((t) => t.emit(created));
  expect((await drainFederation()).deliveries).toBeGreaterThan(0);
});

test.each(personalEventTypes)('%s reaches no other server', async (type) => {
  await tx((t) => t.emit(events[type]));
  expect(await drainFederation()).toEqual({ activities: 0, deliveries: 0, emitted: 0 });
});

test('the delivery consumer takes every personal event and drops it', async () => {
  expect(delivery.events).toEqual(expect.arrayContaining([...personalEventTypes]));
  for (const type of personalEventTypes) await tx((t) => delivery.handle(events[type], t));
  expect(await db().select().from(activities)).toEqual([]);
  expect(await db().select().from(deliveries)).toEqual([]);
  expect(await db().select().from(outbox)).toEqual([]);
});
