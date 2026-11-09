import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { db } from '@peblish/core/db/read';
import { posts } from '@peblish/core/db/tables/content';
import { activities } from '@peblish/core/db/tables/federation';
import { follows } from '@peblish/core/db/tables/follows';
import { instances } from '@peblish/core/db/tables/instances';
import { writer } from '@peblish/core/db/write';
import { deliveries } from '@peblish/core/delivery/tables';
import { truncateAll } from '@peblish/core/testing/db';
import { deliveryBlocked } from '@peblish/core/peers/gate';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { seedPost } from '@peblish/core/testing/seed-az';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { inboxState, seedFollow, seedInboundWorld, seedInboxRow, seedPeerActor } from '@peblish/core/testing/seed-fed-b';
import { tx } from '@peblish/core/tx/tx';
import type { OutboxEvent } from '@peblish/schema/events';
import { consumer as delivery } from '../delivery/consumer.ts';
import { BULK_WITHDRAWAL_CAP } from '../delivery/withdraw.ts';
import { processRow } from '../inbound/pipeline.ts';
import { resetKeyFetchBudget } from '../inbound/throttle.ts';
import { activityId, addressedToCommunity, hosts, PUBLIC } from '../inbound/test-support.ts';
import { consumer as relay } from './consumer.ts';

type Json = Record<string, unknown>;

const shape = (json: unknown): string => {
  const record = json as Json;
  const inner = record.object && typeof record.object === 'object' ? `(${shape(record.object)})` : '';
  return `${String(record.type)}${inner}`;
};
/** What is queued for an inbox, oldest first: shape and signer's id. */
async function sentTo(inbox: string) {
  const rows = await db().select().from(deliveries).where(eq(deliveries.inboxUrl, inbox)).orderBy(deliveries.createdAt, deliveries.id);
  return rows.map((row) => ({ shape: shape(JSON.parse(row.body)), senderId: row.senderId, json: JSON.parse(row.body) as Json }));
}
const clearQueue = () => writer().delete(deliveries);

// Lane MODF fills the gate; the real one stays in place except where a test holds an instance back.
vi.mock('@peblish/core/peers/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@peblish/core/peers/gate')>();
  return { ...actual, deliveryBlocked: vi.fn(actual.deliveryBlocked) };
});

beforeEach(async () => {
  vi.mocked(deliveryBlocked).mockReset();
  vi.mocked(deliveryBlocked).mockResolvedValue(false);
  await truncateAll();
  resetKeyFetchBudget();
});

/** This server with a moderator, a local author, a community, and Lemmy and Mastodon followers. */
async function world() {
  const { instance: here } = await seedLocalInstance();
  const person = async (name: string) => {
    const actor = await seedActor(here, 'Person', name, { inboxUrl: `https://fed-a.test/ap/u.${name}/inbox` });
    await seedSigningKey(actor);
    return actor;
  };
  const moderator = await person('mod');
  const alice = await person('alice');
  const news = await seedActor(here, 'Group', 'news', { inboxUrl: 'https://fed-a.test/ap/c.news/inbox' });
  await seedSigningKey(news);
  const follower = async (domain: string, software: string) => {
    const instance = await seedInstance(domain, false);
    await writer().update(instances).set({ software }).where(eq(instances.id, instance.id));
    const actor = await seedPeerActor(instance, 'Person', 'fan');
    await writer()
      .insert(follows)
      .values({
        followerId: actor.id,
        followeeId: news.id,
        apId: `https://${domain}/follow/fan`,
        state: 'accepted',
        acceptedAt: new Date(),
      });
    return { instance, actor, inbox: `https://${domain}/inbox` };
  };
  const lemmy = await follower('lemmy.test', 'lemmy');
  const mastodon = await follower('masto.test', 'mastodon');
  return { here, moderator, alice, news, lemmy, mastodon };
}
type World = Awaited<ReturnType<typeof world>>;

/** A post in the community with its Announce(Page) already sent to the Mastodon follower, the queue then cleared. */
async function boosted(w: World, author: { id: string }, instance = w.here, extra: Partial<typeof posts.$inferInsert> = {}) {
  const p = await seedPost(instance, w.news, author, { title: 'Hello', ...extra });
  const announce = `https://fed-a.test/ap/activity/${randomUUID()}`;
  await writer()
    .insert(activities)
    .values({ apId: announce, type: 'Announce', actorApId: w.news.apId, objectApId: p.apId, local: true, raw: {} });
  return p;
}
const mod = (w: World) => ({ v: 1, moderatorId: w.moderator.id, modlogId: randomUUID(), local: true, communityId: w.news.id }) as const;
const removal = (w: World, apId: string, removed = true, reason: string | null = 'spam') =>
  ({ type: 'mod.remove', ...mod(w), target: { kind: 'post', id: randomUUID() }, targetApId: apId, removed, reason }) as OutboxEvent;
const ban = (w: World, target: { id: string; apId: string }, removeContent = true) =>
  ({
    type: 'mod.ban',
    ...mod(w),
    targetActorId: target.id,
    targetApId: target.apId,
    banned: true,
    removeContent,
    expiresAt: null,
    reason: 'p4',
  }) as OutboxEvent;
const runRelay = (e: OutboxEvent) => tx((t) => relay.handle(e, t));

describe('a moderator’s removal of a post', () => {
  test('of a local author’s post reaches Mastodon as the Undo of the boost and the author’s Delete without the reason; Lemmy keeps the Delete with it', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello' });
    await tx((t) =>
      delivery.handle({ type: 'post.created', v: 1, postId: p.id, communityId: w.news.id, authorId: w.alice.id, local: true }, t),
    );
    await clearQueue();
    await runRelay(removal(w, p.apId));

    const toMastodon = await sentTo(w.mastodon.inbox);
    expect(toMastodon.map(({ shape: s, senderId }) => [s, senderId])).toEqual([
      ['Undo(Announce)', w.news.id],
      ['Delete', w.alice.id],
    ]);
    expect(toMastodon[1]!.json.summary).toBeUndefined();
    const toLemmy = await sentTo(w.lemmy.inbox);
    expect(toLemmy.map(({ shape: s }) => s)).toEqual(['Announce(Delete)']);
    expect(toLemmy[0]!.json.object).toMatchObject({ type: 'Delete', actor: w.moderator.apId, object: p.apId, summary: 'spam' });
  });

  test('of a remote author’s post reaches Mastodon as the Undo alone: there is no key for the author', async () => {
    const w = await world();
    const p = await boosted(w, w.lemmy.actor, w.lemmy.instance);
    await runRelay(removal(w, p.apId));
    expect((await sentTo(w.mastodon.inbox)).map(({ shape: s }) => s)).toEqual(['Undo(Announce)']);
    expect((await sentTo(w.lemmy.inbox)).map(({ shape: s }) => s)).toEqual(['Announce(Delete)']);
  });

  test('is withdrawn once; a restoration, a lock and an unlock send Mastodon nothing', async () => {
    const w = await world();
    const p = await boosted(w, w.lemmy.actor, w.lemmy.instance);
    await runRelay(removal(w, p.apId));
    await clearQueue();
    await runRelay(removal(w, p.apId));
    expect(await sentTo(w.mastodon.inbox)).toEqual([]);
    await clearQueue();
    await runRelay(removal(w, p.apId, false, null));
    for (const locked of [true, false]) {
      await runRelay({ type: 'mod.lock', ...mod(w), postId: p.id, targetApId: p.apId, locked, reason: null } as OutboxEvent);
    }
    await runRelay({ type: 'mod.feature', ...mod(w), postId: p.id, targetApId: p.apId, scope: 'community', featured: true } as OutboxEvent);
    expect(await sentTo(w.mastodon.inbox)).toEqual([]);
    expect((await sentTo(w.lemmy.inbox)).map(({ shape: s }) => s)).toHaveLength(4);
  });

  test('a comment removal is not a withdrawal', async () => {
    const w = await world();
    const p = await boosted(w, w.alice);
    await runRelay({ ...removal(w, p.apId), target: { kind: 'comment', id: randomUUID() } } as OutboxEvent);
    expect(await sentTo(w.mastodon.inbox)).toEqual([]);
  });
});

describe('a ban with removeContent', () => {
  test('withdraws each removed post that was boosted: an Undo for each, and the author’s Delete when the author is ours', async () => {
    const w = await world();
    const removedAt = new Date();
    for (let i = 0; i < 3; i++) await boosted(w, w.alice, w.here, { removedAt });
    await boosted(w, w.alice, w.here); // live: stays
    await boosted(w, w.moderator, w.here, { removedAt }); // someone else's: stays
    await runRelay(ban(w, w.alice));
    expect((await sentTo(w.mastodon.inbox)).map(({ shape: s }) => s).sort()).toEqual([
      'Delete',
      'Delete',
      'Delete',
      'Undo(Announce)',
      'Undo(Announce)',
      'Undo(Announce)',
    ]);
    expect((await sentTo(w.lemmy.inbox)).map(({ shape: s }) => s)).toEqual(['Announce(Block)']);

    await clearQueue();
    await runRelay(ban(w, w.alice));
    expect(await sentTo(w.mastodon.inbox)).toEqual([]);
  });

  test('a ban that keeps the content withdraws nothing', async () => {
    const w = await world();
    await boosted(w, w.alice, w.here, { removedAt: new Date() });
    await runRelay(ban(w, w.alice, false));
    expect(await sentTo(w.mastodon.inbox)).toEqual([]);
  });

  test(`one event withdraws at most ${BULK_WITHDRAWAL_CAP} posts`, async () => {
    const w = await world();
    const removedAt = new Date();
    for (let i = 0; i < BULK_WITHDRAWAL_CAP + 1; i++) await boosted(w, w.lemmy.actor, w.lemmy.instance, { removedAt });
    await runRelay(ban(w, w.lemmy.actor));
    expect(await sentTo(w.mastodon.inbox)).toHaveLength(BULK_WITHDRAWAL_CAP);
    // The next event takes the one left.
    await clearQueue();
    await runRelay(ban(w, w.lemmy.actor));
    expect(await sentTo(w.mastodon.inbox)).toHaveLength(1);
  });
});

describe('a site ban', () => {
  const siteBan = (w: World, target: { id: string; apId: string }, extra: Partial<Extract<OutboxEvent, { type: 'mod.ban' }>> = {}) =>
    ({ ...ban(w, target, false), communityId: null, ...extra }) as OutboxEvent;

  test('is a Block of the person with the instance actor as target, signed by the moderator and sent to every peer', async () => {
    const w = await world();
    const expiresAt = '2100-01-01T00:00:00.000Z';
    await runRelay(siteBan(w, w.lemmy.actor, { expiresAt }));
    for (const inbox of [w.lemmy.inbox, w.mastodon.inbox]) {
      const [sent, ...rest] = await sentTo(inbox);
      expect(rest).toEqual([]);
      expect(sent!.senderId).toBe(w.moderator.id);
      expect(sent!.json).toMatchObject({
        type: 'Block',
        actor: w.moderator.apId,
        object: w.lemmy.actor.apId,
        target: 'https://fed-a.test/',
        to: [PUBLIC],
        summary: 'p4',
        removeData: false,
      });
      expect(new Date(String(sent!.json.endTime ?? sent!.json.expires)).toISOString()).toBe(expiresAt);
    }
    // Stored, so it is served at its id.
    const [stored] = await db().select().from(activities).where(eq(activities.type, 'Block'));
    expect(stored).toMatchObject({ local: true, actorApId: w.moderator.apId, objectApId: w.lemmy.actor.apId });
  });

  test('an unban is the Undo embedding that Block', async () => {
    const w = await world();
    await runRelay(siteBan(w, w.alice));
    const [block] = await sentTo(w.lemmy.inbox);
    await runRelay(siteBan(w, w.alice, { banned: false }));
    const undo = (await sentTo(w.lemmy.inbox)).at(-1)!.json;
    expect(undo).toMatchObject({
      type: 'Undo',
      actor: w.moderator.apId,
      object: { type: 'Block', id: block!.json.id, target: 'https://fed-a.test/' },
    });
  });

  test('skips the inboxes of an instance where deliveries are held back', async () => {
    const w = await world();
    vi.mocked(deliveryBlocked).mockImplementation(async (instanceId) => instanceId === w.lemmy.instance.id);
    await runRelay(siteBan(w, w.alice));
    expect(await sentTo(w.lemmy.inbox)).toEqual([]);
    expect((await sentTo(w.mastodon.inbox)).map(({ shape: s }) => s)).toEqual(['Block']);
  });

  test('with removeContent takes back the boost of every removed post in every batch, and only the banned person’s', async () => {
    const w = await world();
    const removedAt = new Date();
    for (let i = 0; i < BULK_WITHDRAWAL_CAP + 5; i++) await boosted(w, w.lemmy.actor, w.lemmy.instance, { removedAt });
    await boosted(w, w.lemmy.actor, w.lemmy.instance); // live: stays
    await boosted(w, w.alice, w.here, { removedAt }); // someone else's: stays
    await runRelay(siteBan(w, w.lemmy.actor, { removeContent: true }));
    const toMastodon = (await sentTo(w.mastodon.inbox)).map(({ shape: s }) => s);
    expect(toMastodon.filter((s) => s === 'Undo(Announce)')).toHaveLength(BULK_WITHDRAWAL_CAP + 5);
    expect(toMastodon.filter((s) => s === 'Block')).toHaveLength(1);
    expect(toMastodon).toHaveLength(BULK_WITHDRAWAL_CAP + 6);

    await clearQueue();
    await runRelay(siteBan(w, w.lemmy.actor, { removeContent: true }));
    expect((await sentTo(w.mastodon.inbox)).map(({ shape: s }) => s)).toEqual(['Block']);
  });

  test('a ban that keeps the content withdraws nothing, and a remote moderator’s ban is not ours to send', async () => {
    const w = await world();
    await boosted(w, w.alice, w.here, { removedAt: new Date() });
    await runRelay(siteBan(w, w.alice));
    expect((await sentTo(w.mastodon.inbox)).map(({ shape: s }) => s)).toEqual(['Block']);
    await clearQueue();
    await runRelay({ ...siteBan(w, w.alice), local: false } as OutboxEvent);
    expect(await sentTo(w.mastodon.inbox)).toEqual([]);
  });
});

describe('a Delete the community relays', () => {
  /** The inbound world, with followers on Lemmy-like and Mastodon-like servers. */
  async function followed() {
    const world = await seedInboundWorld();
    for (const [domain, software] of [
      ['lemmy.test', 'lemmy'],
      ['piefed.test', 'piefed'],
      ['mastodon.test', 'mastodon'],
    ] as const) {
      await writer().update(instances).set({ software }).where(eq(instances.domain, domain));
    }
    await seedFollow(world.peers.pfuser, world.community, 'https://piefed.test/activities/follow-spike');
    return world;
  }
  const receive = async (document: Json) => {
    const text = JSON.stringify(document, null, 1);
    const row = await seedInboxRow(text, {
      activityId: String(document.id),
      activityType: String(document.type),
      actorApId: String(document.actor),
    });
    expect(await processRow(row)).toEqual({ state: 'applied', error: null });
    expect(await inboxState(row.id)).toEqual({ state: 'applied', error: null });
    return text;
  };
  const page = {
    id: 'https://lemmy.test/post/relay-1',
    type: 'Page',
    attributedTo: hosts.lemmyuser,
    name: 'Relayed',
    content: '<p>body</p>',
    source: { content: 'body', mediaType: 'text/markdown' },
    published: '2026-11-09T10:00:00Z',
    audience: hosts.spike,
    to: [hosts.spike, PUBLIC],
  };
  const mastodon = 'https://mastodon.test/inbox';

  test('takes the boost of a remote post back with the Undo, to Mastodon only; the others get the received bytes, the origin none', async () => {
    await followed();
    await receive({
      id: activityId('https://lemmy.test', 'create'),
      type: 'Create',
      actor: hosts.lemmyuser,
      object: page,
      ...addressedToCommunity(hosts.spike),
    });
    expect((await sentTo(mastodon)).map(({ shape: s }) => s)).toEqual(['Announce(Page)']);
    await clearQueue();

    const text = await receive({
      id: activityId('https://lemmy.test', 'delete'),
      type: 'Delete',
      actor: hosts.lemmyuser,
      object: page.id,
      ...addressedToCommunity(hosts.spike),
    });
    const [undo] = await sentTo(mastodon);
    expect(await sentTo(mastodon)).toHaveLength(1);
    expect(undo).toMatchObject({ shape: 'Undo(Announce)', json: { actor: hosts.spike, object: { type: 'Announce', object: page.id } } });
    const piefed = await sentTo('https://piefed.test/inbox');
    expect(piefed.map(({ shape: s }) => s)).toEqual(['Announce(Delete)']);
    const rows = await db().select().from(deliveries).where(eq(deliveries.inboxUrl, 'https://piefed.test/inbox'));
    expect(rows[0]!.body.endsWith(`,"object":${text}}`)).toBe(true);
    expect((await db().select().from(deliveries)).some((row) => row.inboxUrl.startsWith('https://lemmy.test'))).toBe(false);
  });

  test('of a comment, or of a post that was never boosted, sends Mastodon nothing', async () => {
    await followed();
    await receive({
      id: activityId('https://lemmy.test', 'create'),
      type: 'Create',
      actor: hosts.lemmyuser,
      object: page,
      ...addressedToCommunity(hosts.spike),
    });
    await clearQueue();
    await receive({
      id: activityId('https://lemmy.test', 'delete'),
      type: 'Delete',
      actor: hosts.lemmyuser,
      object: hosts.t1,
      ...addressedToCommunity(hosts.spike),
    });
    expect(await sentTo(mastodon)).toEqual([]);
    expect(
      await db()
        .select()
        .from(activities)
        .where(and(eq(activities.type, 'Undo'), eq(activities.local, true))),
    ).toEqual([]);
  });
});
