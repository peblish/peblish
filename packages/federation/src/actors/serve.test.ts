import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { activities } from '@peblish/core/db/tables/federation';
import { follows } from '@peblish/core/db/tables/follows';
import { communityModerators } from '@peblish/core/db/tables/moderation';
import { actors } from '@peblish/core/db/tables/actors';
import { comments, posts } from '@peblish/core/db/tables/content';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { seedComment, seedPost } from '@peblish/core/testing/seed-az';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import { eq } from 'drizzle-orm';
import { actorFromWire } from '../mapping/actor.ts';
import { fromWire } from '../mapping/document.ts';
import type { JsonObject } from '../mapping/json.ts';
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

  test('a remote post is not served from here', async () => {
    const w = await world();
    const peer = await seedInstance('peer.test', false);
    const bob = await seedActor(peer, 'Person', 'bob');
    const remote = await seedPost(peer, w.news, bob);
    expect(await get(`/ap/post/${remote.id}`)).toBeNull();
  });
});
