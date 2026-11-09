import { randomUUID as uuidv7 } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { deliveries } from '@peblish/core/delivery/tables';
import { follows } from '@peblish/core/db/tables/follows';
import { instances } from '@peblish/core/db/tables/instances';
import { writer } from '@peblish/core/db/write';
import { tx } from '@peblish/core/tx/tx';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { inboxState, seedFollow, seedInboundWorld, seedInboxRow, seedPeerActor } from '@peblish/core/testing/seed-fed-b';
import type { OutboxEvent } from '@peblish/schema/events';
import { processRow } from '../inbound/pipeline.ts';
import { resetKeyFetchBudget } from '../inbound/throttle.ts';
import { activityId, addressedToCommunity, hosts, PUBLIC } from '../inbound/test-support.ts';
import { consumer } from './consumer.ts';

type Json = Record<string, unknown>;

const queued = async () =>
  (await db().select().from(deliveries).orderBy(deliveries.inboxUrl)).map((row) => ({
    inbox: row.inboxUrl,
    body: row.body,
    json: JSON.parse(row.body) as Json,
  }));
const shape = (json: unknown): string => {
  const record = json as Json;
  const inner = record.object && typeof record.object === 'object' ? `(${shape(record.object)})` : '';
  return `${String(record.type)}${inner}`;
};
const shapes = async () => Object.fromEntries((await queued()).map((row) => [row.inbox, shape(row.json)]));

beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
});

describe('what reaches a local community directly is announced to its followers', () => {
  /** The inbound world, with followers on Lemmy, PieFed and Mastodon-like servers. */
  async function followed() {
    const world = await seedInboundWorld();
    for (const [domain, software] of [
      ['lemmy.test', 'lemmy'],
      ['piefed.test', 'piefed'],
      ['mastodon.test', 'mastodon'],
    ] as const) {
      await writer().update(instances).set({ software }).where(eq(instances.domain, domain));
    }
    await seedFollow(world.peers.lemmyadmin, world.community, 'https://lemmy.test/activities/follow-spike');
    await seedFollow(world.peers.pfuser, world.community, 'https://piefed.test/activities/follow-spike');
    return world;
  }

  // Pretty-printed with a one-element array and an unknown term: what a re-serialiser would change.
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

  test('the Announce carries the received bytes exactly, and nothing goes back to the sender’s server', async () => {
    await followed();
    const text = await receive({
      id: activityId('https://lemmy.test', 'like'),
      type: 'Like',
      actor: hosts.lemmyuser,
      object: hosts.t1,
      audience: hosts.spike,
      'urn:odd': ['kept'],
    });
    const rows = await queued();
    expect(rows.map((row) => row.inbox)).toEqual(['https://mastodon.test/inbox', 'https://piefed.test/inbox']);
    for (const row of rows) {
      expect(row.body.endsWith(`,"object":${text}}`)).toBe(true);
      expect(row.json).toMatchObject({ type: 'Announce', actor: hosts.spike, to: [PUBLIC] });
    }
  });

  test('a new post is Announce(Create) for Lemmy-like followers and Announce(Page) for Mastodon-like ones, never both', async () => {
    await followed();
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
    const text = await receive({
      id: activityId('https://lemmy.test', 'create'),
      type: 'Create',
      actor: hosts.lemmyuser,
      object: page,
      ...addressedToCommunity(hosts.spike),
    });
    expect(await shapes()).toEqual({
      'https://mastodon.test/inbox': 'Announce(Page)',
      'https://piefed.test/inbox': 'Announce(Create(Page))',
    });
    const piefed = (await queued()).find((row) => row.inbox === 'https://piefed.test/inbox')!;
    expect(piefed.body.endsWith(`,"object":${text}}`)).toBe(true);
  });
});

/** This server with a community and a moderator, peers following the community, and a remote community. */
async function outbound() {
  const { instance: here } = await seedLocalInstance();
  const moderator = await seedActor(here, 'Person', 'mod', {
    inboxUrl: 'https://fed-a.test/ap/u.mod/inbox',
    sharedInboxUrl: 'https://fed-a.test/inbox',
  });
  const news = await seedActor(here, 'Group', 'news', {
    inboxUrl: 'https://fed-a.test/ap/c.news/inbox',
    sharedInboxUrl: 'https://fed-a.test/inbox',
    featuredUrl: 'https://fed-a.test/ap/c.news/featured',
    moderatorsUrl: 'https://fed-a.test/ap/c.news/moderators',
  });
  await seedSigningKey(moderator);
  await seedSigningKey(news);
  const lemmy = await seedInstance('lemmy.test', false);
  await writer().update(instances).set({ software: 'lemmy' }).where(eq(instances.id, lemmy.id));
  const bob = await seedPeerActor(lemmy, 'Person', 'bob');
  const lab = await seedPeerActor(lemmy, 'Group', 'lab');
  await writer()
    .insert(follows)
    .values({ followerId: bob.id, followeeId: news.id, apId: 'https://lemmy.test/follow/bob', state: 'accepted', acceptedAt: new Date() });
  return { here, moderator, news, bob, lab };
}
type Outbound = Awaited<ReturnType<typeof outbound>>;

const run = (event: OutboxEvent) => tx((t) => consumer.handle(event, t));
const mod = (w: Outbound, community = w.news.id, local = true) =>
  ({ v: '1', moderatorId: w.moderator.id, modlogId: uuidv7(), local, communityId: community }) as const;
const target = 'https://fed-a.test/post/7';

describe('a moderation action taken here is federated through the community', () => {
  test('removal and restoration: Delete with the reason, then Undo(Delete) embedding that Delete', async () => {
    const w = await outbound();
    const ref = { kind: 'post', id: uuidv7() } as const;
    await run({ type: 'mod.remove', ...mod(w), target: ref, targetApId: target, removed: true, reason: 'spam' } as OutboxEvent);
    const [removed] = await queued();
    expect(removed?.inbox).toBe('https://lemmy.test/inbox');
    expect(removed?.json).toMatchObject({ type: 'Announce', actor: w.news.apId });
    const del = (removed!.json.object as Json) ?? {};
    expect(del).toMatchObject({ type: 'Delete', actor: w.moderator.apId, object: target, summary: 'spam' });

    await run({ type: 'mod.remove', ...mod(w), target: ref, targetApId: target, removed: false, reason: null } as OutboxEvent);
    const undo = ((await queued()).at(-1)!.json.object as Json) ?? {};
    expect(undo).toMatchObject({ type: 'Undo' });
    expect((undo.object as Json).id).toBe(del.id);
  });

  test('lock and unlock, pin and unpin, ban and unban, and a moderator added', async () => {
    const w = await outbound();
    await run({ type: 'mod.lock', ...mod(w), postId: uuidv7(), targetApId: target, locked: true, reason: null } as OutboxEvent);
    await run({ type: 'mod.lock', ...mod(w), postId: uuidv7(), targetApId: target, locked: false, reason: null } as OutboxEvent);
    await run({ type: 'mod.feature', ...mod(w), postId: uuidv7(), targetApId: target, scope: 'community', featured: true } as OutboxEvent);
    await run({ type: 'mod.feature', ...mod(w), postId: uuidv7(), targetApId: target, scope: 'community', featured: false } as OutboxEvent);
    await run({ type: 'mod.feature', ...mod(w), postId: uuidv7(), targetApId: target, scope: 'local', featured: true } as OutboxEvent);
    const expires = '2100-01-01T00:00:00.000Z';
    await run({
      type: 'mod.ban',
      ...mod(w),
      targetActorId: w.bob.id,
      targetApId: w.bob.apId,
      banned: true,
      removeContent: true,
      expiresAt: expires,
      reason: 'p4',
    } as OutboxEvent);
    await run({
      type: 'mod.ban',
      ...mod(w),
      targetActorId: w.bob.id,
      targetApId: w.bob.apId,
      banned: false,
      removeContent: false,
      expiresAt: null,
      reason: null,
    } as OutboxEvent);
    await run({ type: 'mod.role', ...mod(w), actorId: w.bob.id, role: 'moderator' } as OutboxEvent);
    await run({ type: 'mod.role', ...mod(w), actorId: w.bob.id, role: null } as OutboxEvent);

    const inner = (await queued()).map((row) => row.json.object as Json);
    // The local pin (the site's front page) is not federated: eight activities from nine events.
    expect(inner.map(shape)).toHaveLength(8);
    const byType = (type: string) => inner.filter((activity) => activity.type === type);
    const [lock, ...rest] = inner;
    expect(lock).toMatchObject({ type: 'Lock', object: target });
    expect(rest[0]).toMatchObject({ type: 'Undo', object: { type: 'Lock', id: lock!.id } });
    expect(byType('Add').map((a) => a.target)).toEqual([
      'https://fed-a.test/ap/c.news/featured',
      'https://fed-a.test/ap/c.news/moderators',
    ]);
    expect(byType('Remove').map((a) => a.target)).toEqual([
      'https://fed-a.test/ap/c.news/featured',
      'https://fed-a.test/ap/c.news/moderators',
    ]);
    const block = byType('Block')[0]!;
    expect(block).toMatchObject({ object: w.bob.apId, target: w.news.apId, removeData: true });
    expect(new Date(String(block.endTime ?? block.expires)).toISOString()).toBe(expires);
    expect(byType('Undo').map((a) => (a.object as Json).type)).toEqual(['Lock', 'Block']);
  });

  test('what a peer did, a community we do not host, a site ban and a moderator no longer here are not federated', async () => {
    const w = await outbound();
    const ref = { kind: 'post', id: uuidv7() } as const;
    await run({
      type: 'mod.remove',
      ...mod(w, w.news.id, false),
      target: ref,
      targetApId: target,
      removed: true,
      reason: null,
    } as OutboxEvent);
    await run({ type: 'mod.remove', ...mod(w, w.lab.id), target: ref, targetApId: target, removed: true, reason: null } as OutboxEvent);
    await run({
      type: 'mod.ban',
      ...mod(w),
      communityId: null,
      targetActorId: w.bob.id,
      targetApId: w.bob.apId,
      banned: true,
      removeContent: false,
      expiresAt: null,
      reason: null,
    } as OutboxEvent);
    await run({
      type: 'mod.lock',
      ...mod(w),
      moderatorId: null,
      postId: uuidv7(),
      targetApId: target,
      locked: true,
      reason: null,
    } as OutboxEvent);
    expect(await queued()).toEqual([]);
  });

  test('a local account’s deletion is a Delete of the account to the peers; a remote one is not ours to send', async () => {
    const w = await outbound();
    await run({ type: 'actor.deleted', v: '1', actorId: w.moderator.id, kind: 'Person', local: true } as OutboxEvent);
    const rows = await queued();
    expect(rows.map((row) => shape(row.json))).toEqual(['Delete']);
    expect(rows[0]?.json).toMatchObject({ actor: w.moderator.apId, object: w.moderator.apId });
    await run({ type: 'actor.deleted', v: '1', actorId: w.bob.id, kind: 'Person', local: false } as OutboxEvent);
    await run({ type: 'actor.deleted', v: '1', actorId: w.news.id, kind: 'Group', local: true } as OutboxEvent);
    expect(await queued()).toHaveLength(1);
  });
});
