import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { siteBans } from '@peblish/core/bans/tables';
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
import { outboxEvents, seedPost } from '@peblish/core/testing/seed-az';
import { seedModlog } from '@peblish/core/testing/seed-e2';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { inboxState, seedFollow, seedInboundWorld, seedInboxRow, seedPeerActor } from '@peblish/core/testing/seed-fed-b';
import { tx } from '@peblish/core/tx/tx';
import type { OutboxEvent } from '@peblish/schema/events';
import { localDocument } from '../actors/serve.ts';
import { consumer as delivery } from '../delivery/consumer.ts';
import { BULK_WITHDRAWAL_CAP, withdrawalLock, withdrawRemaining } from '../delivery/withdraw.ts';
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
  // The modlog rows the events point at: one in the public log, one kept out of it.
  const logs = {
    public: (await seedModlog(moderator, alice)).id,
    private: (await seedModlog(moderator, alice, { public: false })).id,
  };
  return { here, moderator, alice, news, lemmy, mastodon, logs };
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
const mod = (w: World, log: 'public' | 'private' = 'public') =>
  ({ v: 1, moderatorId: w.moderator.id, modlogId: w.logs[log], local: true, communityId: w.news.id }) as const;
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
/** The tests that seed over 200 boosted posts, which the shared Postgres can slow past the default 5 seconds. */
const bulkTimeoutMs = 30_000;

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

  test('reaches the people it was sent to for a mention: the moderator’s Delete, and on a Mastodon-like server the author’s Delete', async () => {
    const w = await world();
    const peer = async (domain: string, software: string) => {
      const instance = await seedInstance(domain, false);
      await writer().update(instances).set({ software }).where(eq(instances.id, instance.id));
      return seedActor(instance, 'Person', 'eve', { inboxUrl: `https://${domain}/u/eve/inbox`, sharedInboxUrl: `https://${domain}/inbox` });
    };
    await peer('toot.test', 'mastodon');
    await peer('other.test', 'lemmy');
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello', bodyMd: 'for @eve@toot.test and @eve@other.test' });
    await tx((t) =>
      delivery.handle({ type: 'post.created', v: 1, postId: p.id, communityId: w.news.id, authorId: w.alice.id, local: true }, t),
    );
    expect((await sentTo('https://toot.test/inbox')).map(({ shape: s }) => s)).toEqual(['Create(Page)']);
    await clearQueue();
    await runRelay(removal(w, p.apId));
    expect((await sentTo('https://toot.test/inbox')).map(({ shape: s, senderId }) => [s, senderId])).toEqual([
      ['Delete', w.moderator.id],
      ['Delete', w.alice.id],
    ]);
    expect((await sentTo('https://other.test/inbox')).map(({ shape: s, senderId }) => [s, senderId])).toEqual([['Delete', w.moderator.id]]);
    await clearQueue();
    await runRelay(removal(w, p.apId, false, null));
    expect((await sentTo('https://other.test/inbox')).map(({ shape: s }) => s)).toEqual(['Undo(Delete)']);
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

  test(
    `one event withdraws at most ${BULK_WITHDRAWAL_CAP} posts`,
    async () => {
      const w = await world();
      const removedAt = new Date();
      for (let i = 0; i < BULK_WITHDRAWAL_CAP + 1; i++) await boosted(w, w.lemmy.actor, w.lemmy.instance, { removedAt });
      await runRelay(ban(w, w.lemmy.actor));
      expect(await sentTo(w.mastodon.inbox)).toHaveLength(BULK_WITHDRAWAL_CAP);
      // The next event takes the one left.
      await clearQueue();
      await runRelay(ban(w, w.lemmy.actor));
      expect(await sentTo(w.mastodon.inbox)).toHaveLength(1);
    },
    bulkTimeoutMs,
  );
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

  test(
    'with removeContent takes back one batch in the event’s transaction and the rest in the job’s, only the banned person’s',
    async () => {
      const w = await world();
      const removedAt = new Date();
      for (let i = 0; i < BULK_WITHDRAWAL_CAP + 5; i++) await boosted(w, w.lemmy.actor, w.lemmy.instance, { removedAt });
      await boosted(w, w.lemmy.actor, w.lemmy.instance); // live: stays
      await boosted(w, w.alice, w.here, { removedAt }); // someone else's: stays
      await writer().insert(siteBans).values({ actorId: w.lemmy.actor.id, source: 'local', removeContent: true });
      await runRelay(siteBan(w, w.lemmy.actor, { removeContent: true }));
      const undos = async () => (await sentTo(w.mastodon.inbox)).filter(({ shape: s }) => s === 'Undo(Announce)').length;
      expect(await undos()).toBe(BULK_WITHDRAWAL_CAP);
      expect((await sentTo(w.mastodon.inbox)).filter(({ shape: s }) => s === 'Block')).toHaveLength(1);

      // The job resumes from what is left: the five, in a transaction of its own, then nothing.
      expect(await withdrawRemaining({ maxBatches: 1 })).toBe(5);
      expect(await undos()).toBe(BULK_WITHDRAWAL_CAP + 5);
      expect(await withdrawRemaining()).toBe(0);
      expect(await sentTo(w.mastodon.inbox)).toHaveLength(BULK_WITHDRAWAL_CAP + 6);

      await clearQueue();
      await runRelay(siteBan(w, w.lemmy.actor, { removeContent: true }));
      expect((await sentTo(w.mastodon.inbox)).map(({ shape: s }) => s)).toEqual(['Block']);
    },
    bulkTimeoutMs,
  );

  test(
    'the job takes at most one batch per transaction, and skips a person another transaction is withdrawing',
    async () => {
      const w = await world();
      const removedAt = new Date();
      for (let i = 0; i < BULK_WITHDRAWAL_CAP + 1; i++) await boosted(w, w.lemmy.actor, w.lemmy.instance, { removedAt });
      await writer().insert(siteBans).values({ actorId: w.lemmy.actor.id, source: 'local', removeContent: true });
      const undos = async () => (await sentTo(w.mastodon.inbox)).length;

      // Another transaction holds the person's withdrawal lock: the job leaves them alone.
      let release!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (locked = resolve));
      const holder = tx(async (t) => {
        await t.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${withdrawalLock(w.lemmy.actor.id)}, 0))`);
        locked();
        await new Promise<void>((resolve) => (release = resolve));
      });
      await held;
      expect(await withdrawRemaining()).toBe(0);
      expect(await undos()).toBe(0);
      release();
      await holder;

      expect(await withdrawRemaining({ maxBatches: 1 })).toBe(BULK_WITHDRAWAL_CAP);
      expect(await undos()).toBe(BULK_WITHDRAWAL_CAP);
      expect(await withdrawRemaining()).toBe(1);
    },
    bulkTimeoutMs,
  );

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

describe('a reason kept out of the public modlog', () => {
  /** Each activity queued for Lemmy, as sent and as served at its id (the outer Announce and what it embeds). */
  async function sentAndServed(w: World) {
    const sent = (await sentTo(w.lemmy.inbox)).map(({ json }) => json);
    const served = await Promise.all(
      sent.map(async (json) => (await localDocument(db(), 'https://fed-a.test', new URL(String(json.id)).pathname))?.json),
    );
    const inner = sent.flatMap((json) => (json.object && typeof json.object === 'object' ? [json.object as Json] : []));
    const servedInner = await Promise.all(
      inner.map(async (json) => (await localDocument(db(), 'https://fed-a.test', new URL(String(json.id)).pathname))?.json),
    );
    return [...sent, ...served, ...inner, ...servedInner];
  }
  const summaries = (documents: unknown[]) => JSON.stringify(documents).match(/"summary":"[^"]*"/g) ?? [];

  test('never leaves: a removal, its restoration, a community ban, its unban and a site ban carry no summary, sent or served', async () => {
    const w = await world();
    const p = await boosted(w, w.alice);
    const remove = removal(w, p.apId, true, 'Statement of reasons, case 12');
    await runRelay({ ...remove, modlogId: w.logs.private } as OutboxEvent);
    await runRelay({ ...removal(w, p.apId, false, 'Restored after appeal'), modlogId: w.logs.private } as OutboxEvent);
    await runRelay({ ...ban(w, w.lemmy.actor, false), modlogId: w.logs.private, reason: 'private ban' } as OutboxEvent);
    await runRelay({ ...ban(w, w.lemmy.actor, false), modlogId: w.logs.private, banned: false, reason: 'private unban' } as OutboxEvent);
    await runRelay({ ...ban(w, w.alice, false), communityId: null, modlogId: w.logs.private, reason: 'private site ban' } as OutboxEvent);
    const documents = await sentAndServed(w);
    expect(documents.map((json) => (json as Json | undefined)?.type)).not.toContain(undefined);
    expect((await sentTo(w.lemmy.inbox)).map(({ shape: s }) => s)).toEqual([
      'Announce(Delete)',
      'Announce(Undo(Delete))',
      'Announce(Block)',
      'Announce(Undo(Block))',
      'Block',
    ]);
    expect(summaries(documents)).toEqual([]);
    expect(JSON.stringify(await db().select({ raw: activities.raw }).from(activities))).not.toMatch(/case 12|appeal|private/);
  });

  test('a public row’s reason still goes out', async () => {
    const w = await world();
    const p = await boosted(w, w.alice);
    await runRelay(removal(w, p.apId, true, 'spam'));
    await runRelay({ ...ban(w, w.alice, false), communityId: null } as OutboxEvent);
    expect(new Set(summaries(await sentAndServed(w)))).toEqual(new Set(['"summary":"spam"', '"summary":"p4"']));
  });
});

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

describe('a Delete the community relays', () => {
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

describe('a site ban a peer sets on its own person', () => {
  test('with removeData takes the person’s boosts back from Mastodon-like followers, though the Block goes nowhere', async () => {
    const world = await followed();
    await receive({
      id: activityId('https://lemmy.test', 'create'),
      type: 'Create',
      actor: hosts.lemmyuser,
      object: page,
      ...addressedToCommunity(hosts.spike),
    });
    expect((await sentTo(mastodon)).map(({ shape: s }) => s)).toEqual(['Announce(Page)']);
    await clearQueue();

    // Lemmy's site ban: a Block of its own user aimed at its instance, removeData set.
    await receive({
      id: activityId('https://lemmy.test', 'block'),
      type: 'Block',
      actor: hosts.lemmyadmin,
      object: hosts.lemmyuser,
      target: 'https://lemmy.test/',
      to: [PUBLIC],
      cc: ['https://lemmy.test/', 'https://fed-b.test/'],
      summary: 'Spam',
      removeData: true,
    });
    const [ban] = (await outboxEvents()).filter((event) => (event as { type: string }).type === 'mod.ban') as OutboxEvent[];
    expect(ban).toMatchObject({ local: false, communityId: null, removeContent: true, targetActorId: world.peers.lemmyuser.id });
    await runRelay(ban!);
    const [undo, ...rest] = await sentTo(mastodon);
    expect(rest).toEqual([]);
    expect(undo).toMatchObject({ shape: 'Undo(Announce)', json: { actor: hosts.spike, object: { type: 'Announce', object: page.id } } });
    expect((await db().select().from(deliveries)).map((row) => shape(JSON.parse(row.body)))).toEqual(['Undo(Announce)']);
  });
});
