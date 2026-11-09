import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { deliveries } from '@peblish/core/delivery/tables';
import { activities } from '@peblish/core/db/tables/federation';
import { follows } from '@peblish/core/db/tables/follows';
import { instances } from '@peblish/core/db/tables/instances';
import { writer } from '@peblish/core/db/write';
import { tx } from '@peblish/core/tx/tx';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { grantFor, seedComment, seedPost } from '@peblish/core/testing/seed-az';
import { actorDocument, nodeInfoRoutes, rsaKeys, seedLocalInstance, seedSigningKey, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { receiveFollow } from '@peblish/core/follows/follow';
import type { OutboxEvent } from '@peblish/schema/events';
import { resolveRemoteActor } from '../actors/resolve.ts';
import { consumer } from './consumer.ts';

type Json = Record<string, unknown>;

/** The world: this server with a person and a community, four peers following the community, and a remote community. */
async function world() {
  const { instance: here } = await seedLocalInstance();
  const alice = await seedActor(here, 'Person', 'alice', {
    inboxUrl: 'https://fed-a.test/ap/u.alice/inbox',
    sharedInboxUrl: 'https://fed-a.test/inbox',
  });
  const news = await seedActor(here, 'Group', 'news', {
    inboxUrl: 'https://fed-a.test/ap/c.news/inbox',
    sharedInboxUrl: 'https://fed-a.test/inbox',
  });
  await seedSigningKey(alice);
  await seedSigningKey(news);

  const peer = async (domain: string, software: string | null, name: string) => {
    const instance = await seedInstance(domain, false);
    await writer().update(instances).set({ software }).where(eq(instances.id, instance.id));
    const person = await seedActor(instance, 'Person', name, {
      inboxUrl: `https://${domain}/u/${name}/inbox`,
      sharedInboxUrl: `https://${domain}/inbox`,
    });
    await writer()
      .insert(follows)
      .values({
        followerId: person.id,
        followeeId: news.id,
        apId: `https://${domain}/follow/${name}`,
        state: 'accepted',
        acceptedAt: new Date(),
      });
    return { instance, person, shared: `https://${domain}/inbox`, personal: `https://${domain}/u/${name}/inbox` };
  };
  const lemmy = await peer('lemmy.test', 'lemmy', 'bob');
  const piefed = await peer('piefed.test', 'piefed', 'carol');
  const mastodon = await peer('masto.test', 'mastodon', 'dave');
  const unknown = await peer('unknown.test', null, 'erin');
  const lab = await seedActor(lemmy.instance, 'Group', 'lab', {
    inboxUrl: 'https://lemmy.test/c/lab/inbox',
    sharedInboxUrl: 'https://lemmy.test/inbox',
  });
  return { here, alice, news, lemmy, piefed, mastodon, unknown, lab };
}

const post = (postId: string, communityId: string, authorId: string, type: 'created' | 'updated' | 'deleted' | 'restored', local = true) =>
  ({ type: `post.${type}`, v: 1, postId, communityId, authorId, local }) as OutboxEvent;
const comment = (commentId: string, postId: string, authorId: string, type: 'created' | 'updated' | 'deleted', local = true) =>
  ({ type: `comment.${type}`, v: 1, commentId, postId, authorId, parentId: null, local }) as OutboxEvent;
const run = (event: OutboxEvent) => tx((t) => consumer.handle(event, t));

/** What is queued: inbox, sender and the document, by inbox. */
async function queued() {
  const rows = await db().select().from(deliveries).orderBy(deliveries.inboxUrl);
  return rows.map((row) => ({
    inbox: row.inboxUrl,
    senderId: row.senderId,
    activityApId: row.activityApId,
    json: JSON.parse(row.body) as Json,
    body: row.body,
  }));
}
const shape = (json: unknown): string => {
  const record = json as Json;
  const inner = record.object && typeof record.object === 'object' ? `(${shape(record.object)})` : '';
  return `${String(record.type)}${inner}`;
};
const shapes = async () => Object.fromEntries((await queued()).map((row) => [row.inbox, shape(row.json)]));

beforeEach(truncateAll);

describe('a new post in a local community', () => {
  test('goes to each follower inbox once, as Announce(Create(Page)) or, for Mastodon, Announce(Page), never both', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello', bodyMd: 'Some **text**', url: 'https://example.com/a' });
    await run(post(p.id, w.news.id, w.alice.id, 'created'));
    expect(await shapes()).toEqual({
      [w.lemmy.shared]: 'Announce(Create(Page))',
      [w.piefed.shared]: 'Announce(Create(Page))',
      [w.unknown.shared]: 'Announce(Create(Page))',
      [w.mastodon.shared]: 'Announce(Page)',
    });
    const rows = await queued();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.senderId))).toEqual(new Set([w.news.id]));
    // One Announce activity for the three threadiverse inboxes, one for the Mastodon copy.
    expect(new Set(rows.map((row) => row.activityApId)).size).toBe(2);
    const stored = await db().select({ type: activities.type, actor: activities.actorApId }).from(activities);
    expect(stored.map((row) => row.type).sort()).toEqual(['Announce', 'Announce', 'Create']);
    const create = await db().select().from(activities).where(eq(activities.type, 'Create'));
    expect(create[0]).toMatchObject({ local: true, actorApId: w.alice.apId, objectApId: p.apId });
    const announce = rows.find((row) => row.inbox === w.lemmy.shared)!.json as Json & { object: Json & { object: Json } };
    expect(announce).toMatchObject({ actor: w.news.apId, cc: [`${w.news.apId}/followers`] });
    expect(announce.object).toMatchObject({ type: 'Create', actor: w.alice.apId, id: create[0]!.apId });
    expect(announce.object.object).toMatchObject({ type: 'Page', id: p.apId, name: 'Hello', audience: w.news.apId });
    expect(announce.object.object.content).toContain('<strong>text</strong>');
    expect((announce.object.object.source as Json).content).toBe('Some **text**');
    expect(announce.object.object.attachment).toEqual([{ href: 'https://example.com/a', type: 'Link' }]);
  });

  test('a Mastodon server that has just been followed is announced to as Announce(Page) from the first post', async () => {
    const w = await world();
    // The follower arrives the way FED-B receives it: resolved (which reads its NodeInfo), then accepted.
    const document = actorDocument('new-masto.test', 'zed', { publicKeyPem: rsaKeys().publicKeyPem });
    const { fetch } = stubFetch({ [document.id]: { body: document }, ...nodeInfoRoutes('new-masto.test', 'mastodon', '4.4.0') });
    const zed = await resolveRemoteActor(document.id, { fetch });
    const grant = await grantFor(
      'follow.receive',
      { kind: 'remote', actorId: zed.id, announcedBy: null },
      { communityId: w.news.id, followApId: 'https://new-masto.test/follows/1' },
    );
    await receiveFollow(grant);
    await run({
      type: 'follow.accepted',
      v: 1,
      followId: (await db().select().from(follows).where(eq(follows.followerId, zed.id)))[0]!.id,
      apId: 'https://new-masto.test/follows/1',
      followerId: zed.id,
      followeeId: w.news.id,
      followerLocal: false,
      followeeLocal: true,
    });
    const p = await seedPost(w.here, w.news, w.alice, { title: 'First' });
    await run(post(p.id, w.news.id, w.alice.id, 'created'));
    expect((await shapes())['https://new-masto.test/inbox']).toBe('Announce(Page)');
  });

  test('followers on one instance are one delivery, to its shared inbox; local followers and a missing inbox get none', async () => {
    const w = await world();
    const second = await seedActor(w.lemmy.instance, 'Person', 'frank', {
      inboxUrl: 'https://lemmy.test/u/frank/inbox',
      sharedInboxUrl: 'https://lemmy.test/inbox',
    });
    const third = await seedActor(w.lemmy.instance, 'Person', 'gina', { inboxUrl: 'https://lemmy.test/u/gina/inbox' });
    const local = await seedActor(w.here, 'Person', 'henry');
    const gone = await seedActor(w.lemmy.instance, 'Person', 'ivan', { sharedInboxUrl: 'https://lemmy.test/inbox', deletedAt: new Date() });
    for (const [index, person] of [second, third, local, gone].entries()) {
      await writer()
        .insert(follows)
        .values({ followerId: person.id, followeeId: w.news.id, apId: `https://x.test/follow/${index}`, state: 'accepted' });
    }
    await writer()
      .insert(follows)
      .values({
        followerId: (await seedActor(w.lemmy.instance, 'Person', 'jo', { sharedInboxUrl: 'https://lemmy.test/inbox' })).id,
        followeeId: w.news.id,
        apId: 'https://x.test/follow/pending',
        state: 'pending',
      });
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello' });
    await run(post(p.id, w.news.id, w.alice.id, 'created'));
    const inboxes = (await queued()).map((row) => row.inbox).sort();
    expect(inboxes).toEqual(
      ['https://lemmy.test/inbox', 'https://lemmy.test/u/gina/inbox', w.mastodon.shared, w.piefed.shared, w.unknown.shared].sort(),
    );
  });

  test('is not sent for a remote event, a deleted post, or a post that is not ours', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello' });
    await run(post(p.id, w.news.id, w.alice.id, 'created', false));
    const deleted = await seedPost(w.here, w.news, w.alice, { title: 'Gone', deletedAt: new Date() });
    await run(post(deleted.id, w.news.id, w.alice.id, 'created'));
    const removed = await seedPost(w.here, w.news, w.alice, { title: 'Removed', removedAt: new Date() });
    await run(post(removed.id, w.news.id, w.alice.id, 'created'));
    const theirs = await seedPost(w.lemmy.instance, w.lab, w.lemmy.person, { title: 'Theirs' });
    await run(post(theirs.id, w.lab.id, w.lemmy.person.id, 'created'));
    expect(await queued()).toEqual([]);
    expect(await db().select().from(activities)).toEqual([]);
  });

  test('carries a Mention tag for each person it names that we know, and none for one we do not', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.news, w.alice, {
      title: 'Hi',
      bodyMd: 'cc @bob@lemmy.test and @nobody@lemmy.test and @alice@fed-a.test',
    });
    await run(post(p.id, w.news.id, w.alice.id, 'created'));
    const lemmy = (await queued()).find((row) => row.inbox === w.lemmy.shared)!.json as Json & { object: Json & { object: Json } };
    expect(lemmy.object.object.tag).toEqual([
      { type: 'Mention', href: w.lemmy.person.apId, name: '@bob@lemmy.test' },
      { type: 'Mention', href: w.alice.apId, name: '@alice@fed-a.test' },
    ]);
  });
});

describe('everything else in a local community is announced to threadiverse followers; Mastodon-like ones are sent a post, not the rest', () => {
  test('deletes, comments and votes go to Lemmy, PieFed and unknown inboxes as Announce, and to Mastodon nothing', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello' });
    const c = await seedComment(w.here, p, w.alice, { bodyMd: 'a comment' });
    const threadiverse = [w.lemmy.shared, w.piefed.shared, w.unknown.shared];
    const expectThreadiverse = async (expected: string) => {
      expect(await shapes()).toEqual(Object.fromEntries(threadiverse.map((inbox) => [inbox, expected])));
      await writer().delete(deliveries);
    };
    await run(post(p.id, w.news.id, w.alice.id, 'deleted'));
    await expectThreadiverse('Announce(Delete)');
    await run(comment(c.id, p.id, w.alice.id, 'created'));
    await expectThreadiverse('Announce(Create(Note))');
    await run(comment(c.id, p.id, w.alice.id, 'updated'));
    await expectThreadiverse('Announce(Update(Note))');
    await run(comment(c.id, p.id, w.alice.id, 'deleted'));
    await expectThreadiverse('Announce(Delete)');
    await run({
      type: 'vote.cast',
      v: 1,
      voterId: w.alice.id,
      target: { kind: 'post', id: p.id },
      value: 1,
      previous: 0,
      apId: 'https://fed-a.test/ap/activity/like-1',
      previousApId: null,
      local: true,
    });
    await expectThreadiverse('Announce(Like)');
  });

  test('an edit is Announce(Update(Page)) for threadiverse followers and the author’s own Update(Page) for Mastodon, never both', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello', bodyMd: 'Edited **text**' });
    await run(post(p.id, w.news.id, w.alice.id, 'updated'));
    expect(await shapes()).toEqual({
      [w.lemmy.shared]: 'Announce(Update(Page))',
      [w.piefed.shared]: 'Announce(Update(Page))',
      [w.unknown.shared]: 'Announce(Update(Page))',
      [w.mastodon.shared]: 'Update(Page)',
    });
    const rows = await queued();
    const direct = rows.find((row) => row.inbox === w.mastodon.shared)!;
    expect(direct.senderId).toBe(w.alice.id);
    expect(direct.json).toMatchObject({ type: 'Update', actor: w.alice.apId, object: { type: 'Page', id: p.apId } });
    expect((direct.json.object as Json).content).toContain('<strong>text</strong>');
    // The one stored Update is both what Mastodon is sent and what the others' Announce embeds.
    const announced = (rows.find((row) => row.inbox === w.lemmy.shared)!.json.object as Json).id;
    expect(direct.json.id).toBe(announced);
    expect(rows.filter((row) => row.senderId === w.news.id)).toHaveLength(3);
  });

  test('restoring a post undoes the Delete we sent, by its own id', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello' });
    await run(post(p.id, w.news.id, w.alice.id, 'deleted'));
    const sentDelete = (await db().select().from(activities).where(eq(activities.type, 'Delete')))[0]!;
    await writer().delete(deliveries);
    await run(post(p.id, w.news.id, w.alice.id, 'restored'));
    const row = (await queued()).find((entry) => entry.inbox === w.lemmy.shared)!;
    expect(shape(row.json)).toBe('Announce(Undo(Delete))');
    const undo = (row.json as Json & { object: Json & { object: Json } }).object;
    expect(undo.object).toMatchObject({ type: 'Delete', id: sentDelete.apId, actor: w.alice.apId, object: p.apId });
  });

  test('a vote taken back is the Undo of the Like it replaces; a change of direction is only the new vote', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello' });
    const base = { type: 'vote.cast', v: 1, voterId: w.alice.id, target: { kind: 'post', id: p.id }, local: true } as const;
    await run({
      ...base,
      value: -1,
      previous: 1,
      apId: 'https://fed-a.test/ap/activity/dislike-1',
      previousApId: 'https://fed-a.test/ap/activity/like-1',
    });
    expect(Object.values(await shapes())).toEqual(['Announce(Dislike)', 'Announce(Dislike)', 'Announce(Dislike)']);
    await writer().delete(deliveries);
    await run({ ...base, value: 0, previous: -1, apId: null, previousApId: 'https://fed-a.test/ap/activity/dislike-1' });
    const row = (await queued())[0]!;
    expect(shape(row.json)).toBe('Announce(Undo(Dislike))');
    expect(((row.json as Json).object as Json).object).toMatchObject({
      type: 'Dislike',
      id: 'https://fed-a.test/ap/activity/dislike-1',
      object: p.apId,
    });
    await writer().delete(deliveries);
    await run({ ...base, value: 0, previous: 0, apId: null, previousApId: null });
    expect(await queued()).toEqual([]);
  });
});

describe('in a remote community', () => {
  test('the author’s own activity goes to the community’s inbox alone, signed by the author', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.lab, w.alice, { title: 'Hello', bodyMd: 'text' });
    const c = await seedComment(w.here, p, w.alice, { bodyMd: 'a comment' });
    await run(post(p.id, w.lab.id, w.alice.id, 'created'));
    await run(post(p.id, w.lab.id, w.alice.id, 'updated'));
    await run(post(p.id, w.lab.id, w.alice.id, 'deleted'));
    await run(comment(c.id, p.id, w.alice.id, 'created'));
    await run({
      type: 'vote.cast',
      v: 1,
      voterId: w.alice.id,
      target: { kind: 'comment', id: c.id },
      value: 1,
      previous: 0,
      apId: 'https://fed-a.test/ap/activity/like-9',
      previousApId: null,
      local: true,
    });
    const rows = await queued();
    const inbox = 'https://lemmy.test/c/lab/inbox';
    const expected = ['Create(Page)', 'Update(Page)', 'Delete', 'Create(Note)', 'Like'].map((type) => `${inbox} ${type} ${w.alice.id}`);
    expect(rows.map((row) => `${row.inbox} ${shape(row.json)} ${row.senderId}`).sort()).toEqual(expected.sort());
    expect(rows.find((row) => shape(row.json) === 'Create(Note)')?.json).toMatchObject({
      audience: w.lab.apId,
      object: { inReplyTo: p.apId },
    });
  });
});

describe('follows', () => {
  test('a Follow of a remote community, an Accept to a remote follower, an Undo(Follow) on unfollow; nothing else', async () => {
    const w = await world();
    const common = { v: 1, followId: '01a1bddf-bc70-7f9f-87f1-968d3195960a', apId: 'https://fed-a.test/ap/activity/follow-1' } as const;
    await run({
      type: 'follow.requested',
      ...common,
      followerId: w.alice.id,
      followeeId: w.lab.id,
      followerLocal: true,
      followeeLocal: false,
    });
    let rows = await queued();
    expect(rows.map((row) => [row.inbox, row.senderId, row.json])).toMatchObject([
      ['https://lemmy.test/c/lab/inbox', w.alice.id, { type: 'Follow', id: common.apId, actor: w.alice.apId, object: w.lab.apId }],
    ]);
    await writer().delete(deliveries);

    const followApId = 'https://lemmy.test/follow/bob';
    await run({
      type: 'follow.accepted',
      ...common,
      apId: followApId,
      followerId: w.lemmy.person.id,
      followeeId: w.news.id,
      followerLocal: false,
      followeeLocal: true,
    });
    rows = await queued();
    expect(rows.map((row) => [row.inbox, row.senderId, row.json])).toMatchObject([
      [
        w.lemmy.personal,
        w.news.id,
        { type: 'Accept', actor: w.news.apId, object: { type: 'Follow', id: followApId, actor: w.lemmy.person.apId, object: w.news.apId } },
      ],
    ]);
    await writer().delete(deliveries);

    await run({
      type: 'follow.removed',
      ...common,
      followerId: w.alice.id,
      followeeId: w.lab.id,
      followerLocal: true,
      followeeLocal: false,
      by: 'follower',
    });
    rows = await queued();
    expect(rows.map((row) => [row.inbox, row.json])).toMatchObject([
      [
        'https://lemmy.test/c/lab/inbox',
        { type: 'Undo', actor: w.alice.apId, object: { type: 'Follow', id: common.apId, actor: w.alice.apId, object: w.lab.apId } },
      ],
    ]);
    await writer().delete(deliveries);

    // Nothing to send: a Reject from the community, an acceptance of our own Follow, a follow between two local actors.
    await run({
      type: 'follow.removed',
      ...common,
      followerId: w.alice.id,
      followeeId: w.lab.id,
      followerLocal: true,
      followeeLocal: false,
      by: 'followee',
    });
    await run({
      type: 'follow.accepted',
      ...common,
      followerId: w.alice.id,
      followeeId: w.lab.id,
      followerLocal: true,
      followeeLocal: false,
    });
    await run({
      type: 'follow.accepted',
      ...common,
      followerId: w.alice.id,
      followeeId: w.news.id,
      followerLocal: true,
      followeeLocal: true,
    });
    expect(await queued()).toEqual([]);
  });
});

describe('profile edits', () => {
  test('a community’s edit goes to its followers, and a person’s to every server we trade follows with', async () => {
    const w = await world();
    await writer().update(actors).set({ displayName: 'News', summaryMd: 'All the news' }).where(eq(actors.id, w.news.id));
    await run({ type: 'actor.updated', v: 1, actorId: w.news.id, kind: 'Group', local: true });
    expect(Object.keys(await shapes()).sort()).toEqual([w.lemmy.shared, w.mastodon.shared, w.piefed.shared, w.unknown.shared].sort());
    const group = (await queued())[0]!.json as Json & { object: Json };
    expect(group).toMatchObject({
      type: 'Update',
      actor: w.news.apId,
      object: { type: 'Group', id: w.news.apId, name: 'News', summary: '<p>All the news</p>\n' },
    });
    expect(group.object.publicKey).toMatchObject({ id: `${w.news.apId}#main-key`, owner: w.news.apId });
    expect(JSON.stringify(group.object)).not.toContain('PRIVATE');
    await writer().delete(deliveries);

    // alice follows the remote community; bob's server follows our community: two servers, four with the other followers.
    await writer()
      .insert(follows)
      .values({ followerId: w.alice.id, followeeId: w.lab.id, apId: 'https://fed-a.test/ap/activity/f', state: 'accepted' });
    await run({ type: 'actor.updated', v: 1, actorId: w.alice.id, kind: 'Person', local: true });
    expect((await queued()).map((row) => row.inbox).sort()).toEqual(
      [w.lemmy.shared, w.mastodon.shared, w.piefed.shared, w.unknown.shared].sort(),
    );
    expect(shape((await queued())[0]!.json)).toBe('Update(Person)');
    await writer().delete(deliveries);
    await run({ type: 'actor.updated', v: 1, actorId: w.lemmy.person.id, kind: 'Person', local: false });
    expect(await queued()).toEqual([]);
  });
});

describe('sanity', () => {
  test('a delivery row exists for exactly the inboxes, with the activity row served at its id', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello' });
    await run(post(p.id, w.news.id, w.alice.id, 'created'));
    for (const row of await queued()) {
      const [stored] = await db()
        .select()
        .from(activities)
        .where(and(eq(activities.apId, row.activityApId), eq(activities.local, true)));
      expect(stored?.raw).toEqual(row.json);
    }
  });
});
