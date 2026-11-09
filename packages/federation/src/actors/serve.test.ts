import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { activities } from '@peblish/core/db/tables/federation';
import { follows } from '@peblish/core/db/tables/follows';
import { communityModerators } from '@peblish/core/db/tables/moderation';
import { actors } from '@peblish/core/db/tables/actors';
import { comments, posts } from '@peblish/core/db/tables/content';
import { writer } from '@peblish/core/db/write';
import { instances } from '@peblish/core/db/tables/instances';
import { tx } from '@peblish/core/tx/tx';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { seedComment, seedCommunityRemoval, seedPost } from '@peblish/core/testing/seed-az';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { eq, sql } from 'drizzle-orm';
import { actorFromWire } from '../mapping/actor.ts';
import { fromWire } from '../mapping/document.ts';
import type { JsonObject } from '../mapping/json.ts';
import { relayToFollowers } from '../relay/announce.ts';
import { localDocument } from './serve.ts';

const origin = 'https://fed-a.test';
const get = async (path: string) => localDocument(db(), origin, path);
const json = async (path: string) => (await get(path))?.json as JsonObject;

/** This server with a person, a community, an imported admin and one remote follower. */
async function world() {
  const { instance: here, instanceActor } = await seedLocalInstance('fed-a.test');
  await writer()
    .update(actors)
    .set({ inboxUrl: `${origin}/inbox`, outboxUrl: `${origin}/outbox`, sharedInboxUrl: `${origin}/inbox` })
    .where(eq(actors.id, instanceActor.id));
  const urls = (base: string) => ({
    inboxUrl: `${base}/inbox`,
    outboxUrl: `${base}/outbox`,
    followersUrl: `${base}/followers`,
    sharedInboxUrl: `${origin}/inbox`,
  });
  const alice = await seedActor(here, 'Person', 'alice', urls(`${origin}/ap/u.alice`));
  const news = await seedActor(here, 'Group', 'news', {
    ...urls(`${origin}/ap/c.news`),
    displayName: 'News',
    summaryMd: 'All the **news**',
  });
  const admin = await seedActor(here, 'Person', 'feddit-admin', {
    apId: `${origin}/u/feddit-admin`,
    importedAt: new Date(),
    ...urls(`${origin}/u/feddit-admin`),
  });
  const aliceKey = await seedSigningKey(alice);
  await seedSigningKey(news);
  return { here, instanceActor, alice, news, admin, aliceKey };
}

beforeEach(truncateAll);

describe('actor documents', () => {
  test('a Person is served at its ap_id with its public key and never the private one', async () => {
    const w = await world();
    const doc = await json('/ap/u.alice');
    expect(doc).toMatchObject({
      type: 'Person',
      id: w.alice.apId,
      preferredUsername: 'alice',
      inbox: `${origin}/ap/u.alice/inbox`,
      endpoints: { sharedInbox: `${origin}/inbox` },
      publicKey: { id: `${w.alice.apId}#main-key`, owner: w.alice.apId, publicKeyPem: w.aliceKey.publicKeyPem },
    });
    expect(doc['@context']).toEqual(['https://join-lemmy.org/context.json', 'https://www.w3.org/ns/activitystreams']);
    expect(JSON.stringify(doc)).not.toContain('PRIVATE KEY');
    expect(actorFromWire(doc)).toMatchObject({ apId: w.alice.apId, name: 'alice', kind: 'Person' });
  });

  test('a community says where its moderators and pinned posts are, and who may post', async () => {
    await world();
    const doc = await json('/ap/c.news');
    expect(doc).toMatchObject({
      type: 'Group',
      name: 'News',
      attributedTo: `${origin}/ap/c.news/moderators`,
      featured: `${origin}/ap/c.news/featured`,
      followers: `${origin}/ap/c.news/followers`,
      postingRestrictedToMods: false,
    });
  });

  test('the human page path answers with the actor document, by name and case-insensitively, for the right kind only', async () => {
    const w = await world();
    expect((await json('/u/alice')).id).toBe(w.alice.apId);
    expect((await json('/u/Alice')).id).toBe(w.alice.apId);
    expect((await json('/c/news')).id).toBe(w.news.apId);
    expect(await get('/c/alice')).toBeNull();
    expect(await get('/u/news')).toBeNull();
    expect(await get('/u/nobody')).toBeNull();
    expect(await get('/u/%E0%A4%A')).toBeNull();
  });

  test('an imported actor is served at its stored id, with its collections, and not at a rebuilt one', async () => {
    const w = await world();
    expect((await json('/u/feddit-admin')).id).toBe(w.admin.apId);
    expect(await json('/u/feddit-admin/outbox')).toMatchObject({ type: 'OrderedCollection', id: `${origin}/u/feddit-admin/outbox` });
    expect(await json('/u/feddit-admin/followers')).toMatchObject({ type: 'Collection', totalItems: 0 });
    expect(await get('/ap/u.feddit-admin')).toBeNull();
  });

  test('the instance actor is an Application at the root with an empty outbox', async () => {
    await world();
    expect(await json('/')).toMatchObject({
      type: 'Application',
      id: `${origin}/`,
      preferredUsername: 'fed-a.test',
      inbox: `${origin}/inbox`,
    });
    expect(await json('/outbox')).toMatchObject({ type: 'OrderedCollection', id: `${origin}/outbox`, totalItems: 0, orderedItems: [] });
  });

  test('a deleted local actor is still served (200), never gone', async () => {
    const w = await world();
    await writer().update(actors).set({ deletedAt: new Date(), displayName: null }).where(eq(actors.id, w.alice.id));
    const served = await get('/ap/u.alice');
    expect(served?.status).toBe(200);
    expect(served?.json.id).toBe(w.alice.apId);
  });

  test('a remote actor is not ours to serve', async () => {
    const remote = await seedInstance('peer.test', false);
    const bob = await seedActor(remote, 'Person', 'bob');
    expect(await get(new URL(bob.apId).pathname)).toBeNull();
  });
});

describe('collections', () => {
  test('followers counts accepted followers and lists nobody', async () => {
    const w = await world();
    const peer = await seedInstance('peer.test', false);
    const [bob, carol] = [await seedActor(peer, 'Person', 'bob'), await seedActor(peer, 'Person', 'carol')];
    await writer()
      .insert(follows)
      .values([
        { followerId: bob.id, followeeId: w.news.id, apId: 'https://peer.test/f/1', state: 'accepted', acceptedAt: new Date() },
        { followerId: carol.id, followeeId: w.news.id, apId: 'https://peer.test/f/2', state: 'pending' },
      ]);
    expect(await json('/ap/c.news/followers')).toMatchObject({
      type: 'Collection',
      id: `${origin}/ap/c.news/followers`,
      totalItems: 1,
      items: [],
    });
  });

  test('moderators lists owners first and leaves out deleted accounts', async () => {
    const w = await world();
    const dave = await seedActor(w.here, 'Person', 'dave', { deletedAt: new Date() });
    await writer()
      .insert(communityModerators)
      .values([
        { communityId: w.news.id, moderatorId: w.admin.id, role: 'moderator', source: 'local' },
        { communityId: w.news.id, moderatorId: w.alice.id, role: 'owner', source: 'local' },
        { communityId: w.news.id, moderatorId: dave.id, role: 'moderator', source: 'local' },
      ]);
    const doc = await json('/ap/c.news/moderators');
    expect(doc).toMatchObject({
      type: 'OrderedCollection',
      id: `${origin}/ap/c.news/moderators`,
      orderedItems: [w.alice.apId, w.admin.apId],
    });
    expect(fromWire(doc)).toMatchObject({ kind: 'moderators', moderators: { moderatorApIds: [w.alice.apId, w.admin.apId] } });
  });

  test('moderators leaves out rows that are not fresh: expired, or a remote mirror never verified or past its expiry', async () => {
    const w = await world();
    const peer = await seedInstance('peer.test', false);
    const [fresh, expired, unverified, stale] = await Promise.all(
      ['fresh', 'expired', 'unverified', 'stale'].map((name) => seedActor(peer, 'Person', name)),
    );
    const hour = 3_600_000;
    await writer()
      .insert(communityModerators)
      .values([
        { communityId: w.news.id, moderatorId: w.alice.id, role: 'owner', source: 'local' },
        { communityId: w.news.id, moderatorId: w.admin.id, role: 'moderator', source: 'local', expiresAt: new Date(Date.now() - hour) },
        {
          communityId: w.news.id,
          moderatorId: fresh!.id,
          source: 'remote',
          verifiedAt: new Date(),
          expiresAt: new Date(Date.now() + hour),
        },
        { communityId: w.news.id, moderatorId: expired!.id, source: 'local', expiresAt: new Date(Date.now() - hour) },
        { communityId: w.news.id, moderatorId: unverified!.id, source: 'remote', expiresAt: new Date(Date.now() + hour) },
        {
          communityId: w.news.id,
          moderatorId: stale!.id,
          source: 'remote',
          verifiedAt: new Date(),
          expiresAt: new Date(Date.now() - hour),
        },
      ]);
    expect(((await json('/ap/c.news/moderators')).orderedItems as string[]).sort()).toEqual([w.alice.apId, fresh!.apId].sort());
  });

  test('featured lists the pinned live posts as Pages', async () => {
    const w = await world();
    const pinned = await seedPost(w.here, w.news, w.alice, { title: 'Pinned', bodyMd: 'Read me', featuredCommunity: true });
    await seedPost(w.here, w.news, w.alice, { title: 'Plain' });
    await seedPost(w.here, w.news, w.alice, { title: 'Pinned and gone', featuredCommunity: true, deletedAt: new Date() });
    const doc = await json('/ap/c.news/featured');
    const items = doc.orderedItems as JsonObject[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'Page', id: pinned.apId, name: 'Pinned', stickied: true });
    expect(items[0]).not.toHaveProperty('@context');
  });

  test('outbox lists the Create activities of live posts, newest first, without their context', async () => {
    const w = await world();
    const [first, second, gone] = [
      await seedPost(w.here, w.news, w.alice, { title: 'First' }),
      await seedPost(w.here, w.news, w.alice, { title: 'Second' }),
      await seedPost(w.here, w.news, w.alice, { title: 'Gone', removedAt: new Date() }),
    ];
    const create = (post: { apId: string }, at: string) => ({
      apId: `${post.apId}/create`,
      type: 'Create',
      actorApId: w.alice.apId,
      objectApId: post.apId,
      local: true,
      createdAt: new Date(at),
      raw: { '@context': ['x'], type: 'Create', id: `${post.apId}/create`, object: { type: 'Page', id: post.apId } },
    });
    await writer()
      .insert(activities)
      .values([create(first, '2026-01-01T00:00:00Z'), create(second, '2026-01-02T00:00:00Z'), create(gone, '2026-01-03T00:00:00Z')]);
    const doc = await json('/ap/c.news/outbox');
    expect(doc).toMatchObject({ type: 'OrderedCollection', totalItems: 2 });
    expect((doc.orderedItems as JsonObject[]).map((item) => item.id)).toEqual([`${second.apId}/create`, `${first.apId}/create`]);
    expect((doc.orderedItems as JsonObject[])[0]).not.toHaveProperty('@context');
  });

  test('the outbox shows each post as it is now, and nothing of a deleted post or a removed or deleted community', async () => {
    const w = await world();
    const post = await seedPost(w.here, w.news, w.alice, { title: 'Before', bodyMd: 'old text' });
    const pinned = await seedPost(w.here, w.news, w.alice, { title: 'Pinned', featuredCommunity: true });
    const activityId = `${origin}/ap/activity/0190b7a8-0000-7000-8000-0000000000aa`;
    await writer()
      .insert(activities)
      .values({
        apId: activityId,
        type: 'Create',
        actorApId: w.alice.apId,
        objectApId: post.apId,
        local: true,
        raw: { type: 'Create', id: activityId, object: { type: 'Page', id: post.apId, name: 'Before' } },
      });
    await writer()
      .update(posts)
      .set({ title: 'After', bodyMd: 'new text', contentHtml: null, editedAt: new Date() })
      .where(eq(posts.id, post.id));
    const [item] = (await json('/ap/c.news/outbox')).orderedItems as JsonObject[];
    expect(item).toMatchObject({
      type: 'Create',
      id: activityId,
      actor: w.alice.apId,
      object: { type: 'Page', id: post.apId, name: 'After' },
    });
    expect(JSON.stringify(item)).toContain('new text');
    expect(JSON.stringify(item)).not.toContain('old text');

    // The outbox and the pinned posts of a removed community are empty, and so are a deleted one's.
    await seedCommunityRemoval(w.news);
    expect(await json('/ap/c.news/outbox')).toMatchObject({ totalItems: 0, orderedItems: [] });
    expect((await json('/ap/c.news/featured')).orderedItems).toEqual([]);
    await writer().execute(sql`delete from community_removals`);
    expect((await json('/ap/c.news/featured')).orderedItems).toEqual([expect.objectContaining({ id: pinned.apId })]);
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, w.news.id));
    expect(await json('/ap/c.news/outbox')).toMatchObject({ totalItems: 0, orderedItems: [] });
  });

  test('a Person has no featured collection, and an unadvertised or unknown collection is nothing', async () => {
    await world();
    expect(await get('/ap/u.alice/featured')).toBeNull();
    expect(await get('/ap/u.alice/moderators')).toBeNull();
    expect(await get('/ap/u.nobody/followers')).toBeNull();
    expect(await get('/ap/c.news/other')).toBeNull();
  });
});

describe('posts, comments and activities', () => {
  test('a post is a Page in the dialect we send, and reads back as the same post', async () => {
    const w = await world();
    const post = await seedPost(w.here, w.news, w.alice, { title: 'Hello', bodyMd: 'Some **text**', url: 'https://example.com/a' });
    const doc = await json(`/ap/post/${post.id}`);
    expect(doc).toMatchObject({
      type: 'Page',
      id: post.apId,
      attributedTo: w.alice.apId,
      audience: w.news.apId,
      name: 'Hello',
      source: { content: 'Some **text**', mediaType: 'text/markdown' },
      commentsEnabled: true,
    });
    expect(doc.content).toContain('<strong>text</strong>');
    expect(fromWire(doc)).toMatchObject({ kind: 'post', post: { apId: post.apId, title: 'Hello', url: 'https://example.com/a' } });
  });

  test('a deleted or removed post is a 410 Tombstone; a restored one is served again', async () => {
    const w = await world();
    const post = await seedPost(w.here, w.news, w.alice);
    const removed = await seedPost(w.here, w.news, w.alice);
    await writer()
      .update(posts)
      .set({ deletedAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(posts.id, post.id));
    await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, removed.id));
    expect(await get(`/ap/post/${post.id}`)).toEqual({
      status: 410,
      json: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Tombstone',
        id: post.apId,
        formerType: 'Page',
        deleted: '2026-01-01T00:00:00.000Z',
      },
    });
    expect((await get(`/ap/post/${removed.id}`))?.status).toBe(410);
    await writer().update(posts).set({ deletedAt: null }).where(eq(posts.id, post.id));
    expect((await get(`/ap/post/${post.id}`))?.status).toBe(200);
  });

  test('a comment is a Note replying to its post; a deleted one is a Tombstone', async () => {
    const w = await world();
    const post = await seedPost(w.here, w.news, w.alice);
    const note = await seedComment(w.here, post, w.alice, { bodyMd: 'Agreed' });
    const doc = await json(`/ap/comment/${note.id}`);
    expect(doc).toMatchObject({ type: 'Note', id: note.apId, inReplyTo: post.apId, attributedTo: w.alice.apId, cc: [w.news.apId] });
    await writer().update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, note.id));
    expect(await get(`/ap/comment/${note.id}`)).toMatchObject({ status: 410, json: { type: 'Tombstone', formerType: 'Note' } });
  });

  test('a stored local activity is served as stored; a received one and an unknown id are not', async () => {
    const w = await world();
    const stored = {
      '@context': ['x'],
      type: 'Create',
      id: `${origin}/ap/activity/0190b7a8-0000-7000-8000-000000000001`,
      actor: w.alice.apId,
    };
    await writer()
      .insert(activities)
      .values([
        { apId: stored.id, type: 'Create', actorApId: w.alice.apId, local: true, raw: stored },
        {
          apId: `${origin}/ap/activity/0190b7a8-0000-7000-8000-000000000002`,
          type: 'Create',
          actorApId: 'https://peer.test/u/bob',
          local: false,
          raw: {},
        },
      ]);
    expect(await json('/ap/activity/0190b7a8-0000-7000-8000-000000000001')).toEqual(stored);
    expect(await get('/ap/activity/0190b7a8-0000-7000-8000-000000000002')).toBeNull();
    expect(await get('/ap/activity/0190b7a8-0000-7000-8000-000000000003')).toBeNull();
  });

  test('a stored local Flag is never served: it names the reporter and their reason', async () => {
    const w = await world();
    const id = `${origin}/ap/activity/0190b7a8-0000-7000-8000-000000000004`;
    await writer()
      .insert(activities)
      .values({ apId: id, type: 'Flag', actorApId: w.alice.apId, local: true, raw: { type: 'Flag', id, actor: w.alice.apId } });
    expect(await get('/ap/activity/0190b7a8-0000-7000-8000-000000000004')).toBeNull();
  });

  describe('nothing is served once what it belongs to is gone', () => {
    const tombstone = (id: string, formerType: string) => ({
      status: 410,
      json: expect.objectContaining({ type: 'Tombstone', id, formerType }),
    });

    test('posts and comments of a removed or deleted community are Tombstones, and come back with it', async () => {
      const w = await world();
      const post = await seedPost(w.here, w.news, w.alice);
      const note = await seedComment(w.here, post, w.alice);
      await seedCommunityRemoval(w.news);
      expect(await get(`/ap/post/${post.id}`)).toMatchObject(tombstone(post.apId, 'Page'));
      expect(await get(`/ap/comment/${note.id}`)).toMatchObject(tombstone(note.apId, 'Note'));
      await writer().execute(sql`delete from community_removals`);
      expect((await get(`/ap/post/${post.id}`))?.status).toBe(200);
      await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, w.news.id));
      expect(await get(`/ap/post/${post.id}`)).toMatchObject(tombstone(post.apId, 'Page'));
      expect(await get(`/ap/comment/${note.id}`)).toMatchObject(tombstone(note.apId, 'Note'));
    });

    test('a comment on a deleted or removed post is a Tombstone, a reply to a deleted comment is not', async () => {
      const w = await world();
      const post = await seedPost(w.here, w.news, w.alice);
      const parent = await seedComment(w.here, post, w.alice);
      const reply = await seedComment(w.here, post, w.alice, { parentId: parent.id });
      await writer().update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, parent.id));
      expect((await get(`/ap/comment/${reply.id}`))?.status).toBe(200);
      await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, post.id));
      expect(await get(`/ap/comment/${reply.id}`)).toMatchObject(tombstone(reply.apId, 'Note'));
      await writer().update(posts).set({ removedAt: null, deletedAt: new Date() }).where(eq(posts.id, post.id));
      expect(await get(`/ap/comment/${reply.id}`)).toMatchObject(tombstone(reply.apId, 'Note'));
    });

    /** Stores the activities a post and its comment produced, in the shapes the consumer writes. */
    async function sentFor(w: Awaited<ReturnType<typeof world>>) {
      const post = await seedPost(w.here, w.news, w.alice);
      const note = await seedComment(w.here, post, w.alice);
      const id = (n: number) => `${origin}/ap/activity/0190b7a8-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;
      const page = { type: 'Page', id: post.apId };
      const comment = { type: 'Note', id: note.apId };
      const create = (n: number, object: object) => ({ type: 'Create', id: id(n), actor: w.alice.apId, object });
      const rows = [
        create(1, page),
        { type: 'Update', id: id(2), actor: w.alice.apId, object: page },
        { type: 'Announce', id: id(3), actor: w.news.apId, object: create(4, page) },
        { type: 'Announce', id: id(5), actor: w.news.apId, object: page },
        create(6, comment),
        { type: 'Delete', id: id(7), actor: w.alice.apId, object: post.apId },
        { type: 'Undo', id: id(8), actor: w.alice.apId, object: { type: 'Delete', id: id(7), object: post.apId } },
        { type: 'Announce', id: id(9), actor: w.news.apId, object: { type: 'Delete', id: id(7), object: post.apId } },
        { type: 'Like', id: id(10), actor: w.alice.apId, object: post.apId },
        { type: 'Update', id: id(11), actor: w.alice.apId, object: { type: 'Person', id: w.alice.apId } },
      ];
      await writer()
        .insert(activities)
        .values(rows.map((raw) => ({ apId: raw.id, type: raw.type, actorApId: raw.actor, objectApId: null, local: true, raw })));
      return { post, note, id, types: Object.fromEntries(rows.map((raw) => [raw.id, raw.type])) };
    }

    test('a Create, Update or Announce of deleted or removed content is a Tombstone; a Delete, an Undo and the rest stay', async () => {
      const w = await world();
      const sent = await sentFor(w);
      const served = () => Promise.all(Object.keys(sent.types).map(async (apId) => (await get(new URL(apId).pathname))!));
      // Everything is live: every activity is served as stored.
      expect((await served()).map((each) => each.status)).toEqual(Array(10).fill(200));

      await writer()
        .update(posts)
        .set({ deletedAt: new Date('2026-01-01T00:00:00Z') })
        .where(eq(posts.id, sent.post.id));
      const gone = await served();
      // Create, Update, Announce(Create), Announce(Page) of the post; Create of the comment (its post is gone); then the keepers.
      expect(gone.map((served) => served.status)).toEqual([410, 410, 410, 410, 410, 200, 200, 200, 200, 200]);
      expect(gone[0]).toMatchObject({
        json: { type: 'Tombstone', id: sent.id(1), formerType: 'Create', deleted: '2026-01-01T00:00:00.000Z' },
      });
      expect(gone[2]).toMatchObject({ json: { type: 'Tombstone', id: sent.id(3), formerType: 'Announce' } });
      expect(gone[5]?.json).toMatchObject({ type: 'Delete', object: sent.post.apId });
    });

    test('an edit is not a deletion: the activity is served as stored while its content lives', async () => {
      const w = await world();
      const sent = await sentFor(w);
      await writer().update(posts).set({ title: 'Edited', editedAt: new Date() }).where(eq(posts.id, sent.post.id));
      expect((await get(new URL(sent.id(1)).pathname))?.status).toBe(200);
      await writer().update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, sent.note.id));
      expect((await get(new URL(sent.id(6)).pathname))?.status).toBe(410);
      expect((await get(new URL(sent.id(1)).pathname))?.status).toBe(200);
    });
  });

  describe('the community’s Announce of someone else’s post or comment', () => {
    /**
     * A remote post and comment in the local community, relayed to a Lemmy-like and a
     * Mastodon-like follower the way the inbox does (relay/announce.ts), which stores one
     * Announce(Create(Page)) and one Announce(Page), and Announce(Create(Note)) for the comment.
     */
    async function relayed() {
      const w = await world();
      const peer = await seedInstance('peer.test', false);
      const bob = await seedActor(peer, 'Person', 'bob', { apId: 'https://peer.test/u/bob' });
      const post = await seedPost(peer, w.news, bob);
      const note = await seedComment(peer, post, bob);
      for (const [domain, software] of [
        ['lemmy.test', 'lemmy'],
        ['mastodon.test', 'mastodon'],
      ] as const) {
        const instance = await seedInstance(domain, false);
        await writer().update(instances).set({ software }).where(eq(instances.id, instance.id));
        const follower = await seedActor(instance, 'Person', 'follower', { inboxUrl: `https://${domain}/inbox` });
        await writer()
          .insert(follows)
          .values({ followerId: follower.id, followeeId: w.news.id, apId: `https://${domain}/follow`, state: 'accepted' });
      }
      const create = (object: JsonObject, n: number): JsonObject => ({
        id: `https://peer.test/activities/${n}`,
        type: 'Create',
        actor: bob.apId,
        object,
      });
      const pageJson: JsonObject = { type: 'Page', id: post.apId, attributedTo: bob.apId, name: post.title };
      const noteJson: JsonObject = { type: 'Note', id: note.apId, attributedTo: bob.apId, inReplyTo: post.apId, content: '<p>x</p>' };
      const relay = (json: JsonObject, page?: Parameters<typeof relayToFollowers>[1]['page']) =>
        tx((t) =>
          relayToFollowers(t, {
            communityId: w.news.id,
            body: new TextEncoder().encode(JSON.stringify(json)),
            json,
            senderApId: bob.apId,
            page,
          }),
        );
      await relay(create(pageJson, 1), {
        apId: post.apId,
        authorApId: bob.apId,
        communityApId: w.news.apId,
        title: post.title,
        url: null,
        urlContentType: null,
        altText: null,
        thumbnailUrl: null,
        bodyMd: null,
        contentHtml: null,
        language: null,
        sensitive: false,
        nsfl: false,
        locked: null,
        featuredCommunity: null,
        publishedAt: null,
        editedAt: null,
        raw: null,
      });
      await relay(create(noteJson, 2));
      const rows = await db()
        .select({ apId: activities.apId, raw: activities.raw })
        .from(activities)
        .where(eq(activities.type, 'Announce'));
      const shape = (raw: unknown): string => {
        const { type, object } = raw as { type: string; object?: unknown };
        return object && typeof object === 'object' ? `${type}(${shape(object)})` : type;
      };
      const announce = (wanted: string) => {
        const row = rows.find((each) => shape(each.raw) === wanted);
        if (!row) throw new Error(`no stored ${wanted}`);
        return new URL(row.apId).pathname;
      };
      return {
        w,
        post,
        note,
        pages: [announce('Announce(Create(Page))'), announce('Announce(Page)')],
        notes: [announce('Announce(Create(Note))')],
      };
    }
    const statuses = (paths: string[]) => Promise.all(paths.map(async (path) => (await get(path))?.status));

    test('both shapes are served while the content lives', async () => {
      const { pages, notes } = await relayed();
      expect(await statuses([...pages, ...notes])).toEqual([200, 200, 200]);
    });

    test('a deleted or removed remote post, and the comments of a gone post, are Tombstones', async () => {
      const { pages, notes, post, note } = await relayed();
      await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, post.id));
      expect(await statuses([...pages, ...notes])).toEqual([410, 410, 410]);
      const deleted = new Date('2026-02-03T04:05:06Z');
      await writer().update(posts).set({ removedAt: null, deletedAt: deleted }).where(eq(posts.id, post.id));
      expect(await get(pages[0]!)).toMatchObject({
        status: 410,
        json: { type: 'Tombstone', formerType: 'Announce', deleted: deleted.toISOString() },
      });
      await writer().update(posts).set({ deletedAt: null }).where(eq(posts.id, post.id));
      expect(await statuses([...pages, ...notes])).toEqual([200, 200, 200]);
      await writer().update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, note.id));
      expect(await statuses([...pages, ...notes])).toEqual([200, 200, 410]);
    });

    test('a removed or deleted community serves none of its Announces', async () => {
      const { pages, notes, w } = await relayed();
      await seedCommunityRemoval(w.news);
      expect(await statuses([...pages, ...notes])).toEqual([410, 410, 410]);
      await writer().execute(sql`delete from community_removals`);
      await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, w.news.id));
      expect(await statuses([...pages, ...notes])).toEqual([410, 410, 410]);
    });

    test('an Announce of content nobody holds is a Tombstone, and the remote object itself is still not served', async () => {
      const { w, post, note } = await relayed();
      const id = 'https://fed-a.test/ap/activity/0190b7a8-0000-7000-8000-0000000000ff';
      const raw = {
        type: 'Announce',
        id,
        actor: w.news.apId,
        object: { type: 'Create', object: { type: 'Page', id: 'https://peer.test/post/unknown' } },
      };
      await writer().insert(activities).values({ apId: id, type: 'Announce', actorApId: w.news.apId, local: true, raw });
      expect(await get(new URL(id).pathname)).toMatchObject({ status: 410, json: { type: 'Tombstone', id, formerType: 'Announce' } });
      expect(await get(`/ap/post/${post.id}`)).toBeNull();
      expect(await get(`/ap/comment/${note.id}`)).toBeNull();
    });
  });

  test('a remote post is not served from here', async () => {
    const w = await world();
    const peer = await seedInstance('peer.test', false);
    const bob = await seedActor(peer, 'Person', 'bob');
    const remote = await seedPost(peer, w.news, bob);
    expect(await get(`/ap/post/${remote.id}`)).toBeNull();
  });
});
