import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { posts } from '@peblish/core/db/tables/content';
import { activities } from '@peblish/core/db/tables/federation';
import { follows } from '@peblish/core/db/tables/follows';
import { instances } from '@peblish/core/db/tables/instances';
import { writer } from '@peblish/core/db/write';
import { deliveries } from '@peblish/core/delivery/tables';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { seedPost } from '@peblish/core/testing/seed-az';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { tx } from '@peblish/core/tx/tx';
import type { OutboxEvent } from '@peblish/schema/events';
import { localDocument } from '../actors/serve.ts';
import { consumer } from './consumer.ts';
import { boostsOf, undoAnnounce } from './withdraw.ts';

type Json = Record<string, unknown>;

/** This server with a person and a community; a Lemmy and a Mastodon server follow the community. */
async function world() {
  const { instance: here } = await seedLocalInstance();
  const alice = await seedActor(here, 'Person', 'alice', { inboxUrl: 'https://fed-a.test/ap/u.alice/inbox' });
  const news = await seedActor(here, 'Group', 'news', { inboxUrl: 'https://fed-a.test/ap/c.news/inbox' });
  await seedSigningKey(alice);
  await seedSigningKey(news);
  const peer = async (domain: string, software: string, name: string) => {
    const instance = await seedInstance(domain, false);
    await writer().update(instances).set({ software }).where(eq(instances.id, instance.id));
    const person = await seedActor(instance, 'Person', name, {
      inboxUrl: `https://${domain}/u/${name}/inbox`,
      sharedInboxUrl: `https://${domain}/inbox`,
    });
    await writer()
      .insert(follows)
      .values({ followerId: person.id, followeeId: news.id, apId: `https://${domain}/follow/${name}`, state: 'accepted' });
    return { instance, person, inbox: `https://${domain}/inbox` };
  };
  const lemmy = await peer('lemmy.test', 'lemmy', 'bob');
  const mastodon = await peer('masto.test', 'mastodon', 'dave');
  return { here, alice, news, lemmy, mastodon };
}
type World = Awaited<ReturnType<typeof world>>;

const event = (w: World, postId: string, type: 'created' | 'updated' | 'deleted' | 'restored') =>
  ({ type: `post.${type}`, v: 1, postId, communityId: w.news.id, authorId: w.alice.id, local: true }) as OutboxEvent;
const run = (e: OutboxEvent) => tx((t) => consumer.handle(e, t));

const shape = (json: unknown): string => {
  const record = json as Json;
  const inner = record.object && typeof record.object === 'object' ? `(${shape(record.object)})` : '';
  return `${String(record.type)}${inner}`;
};
/** What is queued for an inbox, oldest first: shape and signer. */
async function sentTo(inbox: string) {
  const rows = await db()
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.inboxUrl, inbox), eq(deliveries.state, 'pending')))
    .orderBy(deliveries.createdAt, deliveries.id);
  return rows.map((row) => ({ shape: shape(JSON.parse(row.body)), senderId: row.senderId, json: JSON.parse(row.body) as Json }));
}
const clearQueue = () => writer().delete(deliveries);

/** A post published and boosted: the queue is cleared after, so a test sees only what follows. */
async function published(w: World, extra: Partial<typeof posts.$inferInsert> = {}) {
  const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello', ...extra });
  await run(event(w, p.id, 'created'));
  await clearQueue();
  return p;
}
const storedAnnounce = async (postApId: string) =>
  (
    await db()
      .select()
      .from(activities)
      .where(and(eq(activities.type, 'Announce'), eq(activities.objectApId, postApId)))
  )[0]!;

beforeEach(truncateAll);

describe('an author’s delete reaches Mastodon-like followers', () => {
  test('as the community’s Undo of the Announce(Page) and then the author’s Delete; the others get Announce(Delete) only', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello' });
    await run(event(w, p.id, 'created'));
    const boost = await storedAnnounce(p.apId);
    await clearQueue();
    await run(event(w, p.id, 'deleted'));

    expect((await sentTo(w.mastodon.inbox)).map(({ shape: s, senderId }) => [s, senderId])).toEqual([
      ['Undo(Announce)', w.news.id],
      ['Delete', w.alice.id],
    ]);
    expect((await sentTo(w.lemmy.inbox)).map(({ shape: s }) => s)).toEqual(['Announce(Delete)']);
    const [undo, del] = await sentTo(w.mastodon.inbox);
    expect(undo!.json).toMatchObject({
      type: 'Undo',
      actor: w.news.apId,
      object: { id: boost.apId, type: 'Announce', actor: w.news.apId, object: p.apId },
    });
    expect(del!.json).toMatchObject({ type: 'Delete', actor: w.alice.apId, object: p.apId });
    expect(del!.json.summary).toBeUndefined();
    // The Delete Mastodon gets is the Delete the others' Announce embeds: one id for the author's act.
    expect(((await sentTo(w.lemmy.inbox))[0]!.json.object as Json).id).toBe(del!.json.id);
  });

  test('the Undo has the keys Mastodon reads, is served at its id, and marks the boost withdrawn', async () => {
    const w = await world();
    const p = await published(w);
    await run(event(w, p.id, 'deleted'));
    const undo = (await sentTo(w.mastodon.inbox))[0]!.json;
    expect(Object.keys(undo).sort()).toEqual(['@context', 'actor', 'cc', 'id', 'object', 'to', 'type']);
    expect(Object.keys(undo.object as Json).sort()).toEqual(['actor', 'cc', 'id', 'object', 'to', 'type']);
    const served = await localDocument(db(), 'https://fed-a.test', new URL(String(undo.id)).pathname);
    expect(served).toMatchObject({ status: 200, json: undo });
    const boost = await storedAnnounce(p.apId);
    expect(await boostsOf(db(), w.news.apId, p.apId)).toEqual([]);
    expect(undoAnnounce('https://fed-a.test/x', w.news.apId, boost.apId, p.apId)).toMatchObject({ object: { id: boost.apId } });
  });

  test('a second event queues no second Undo or Delete, and a post that was never boosted queues nothing for Mastodon', async () => {
    const w = await world();
    const p = await published(w);
    await run(event(w, p.id, 'deleted'));
    await clearQueue();
    await run(event(w, p.id, 'deleted'));
    expect(await sentTo(w.mastodon.inbox)).toEqual([]);

    await clearQueue();
    const unboosted = await seedPost(w.here, w.news, w.alice, { title: 'Never announced' });
    await run(event(w, unboosted.id, 'deleted'));
    expect(await sentTo(w.mastodon.inbox)).toEqual([]);
    expect((await sentTo(w.lemmy.inbox)).map(({ shape: s }) => s)).toEqual(['Announce(Delete)']);
  });

  test('an instance that unfollowed after the boost still gets the Undo and the Delete', async () => {
    const w = await world();
    const p = await published(w);
    // The boost's delivery rows are what remembers where it went.
    await writer()
      .insert(deliveries)
      .values({
        activityApId: (await storedAnnounce(p.apId)).apId,
        activityType: 'Announce',
        objectApId: p.apId,
        senderId: w.news.id,
        inboxUrl: 'https://gone.test/inbox',
        body: '{}',
        state: 'delivered',
      });
    await writer().delete(follows).where(eq(follows.followerId, w.mastodon.person.id));
    await run(event(w, p.id, 'deleted'));
    expect(await sentTo(w.mastodon.inbox)).toEqual([]);
    expect((await sentTo('https://gone.test/inbox')).map(({ shape: s }) => s)).toEqual(['Undo(Announce)', 'Delete']);
  });
});

describe('what else happens to a post does not reach Mastodon-like inboxes', () => {
  test('a restore, and a vote, queue nothing for them; threadiverse followers are unchanged', async () => {
    const w = await world();
    const p = await published(w);
    await run(event(w, p.id, 'deleted'));
    await clearQueue();
    await run(event(w, p.id, 'restored'));
    expect(await sentTo(w.mastodon.inbox)).toEqual([]);
    expect((await sentTo(w.lemmy.inbox)).map(({ shape: s }) => s)).toEqual(['Announce(Undo(Delete))']);
  });
});
