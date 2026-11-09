import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedComment, seedPost } from '../testing/seed-az.ts';
import { seedBlock } from '../testing/seed-e1.ts';
import { seedInboxWorld, seedModlog, seedNotice } from '../testing/seed-e2.ts';
import { seedActor } from '../testing/seed.ts';
import { readInbox } from './read.ts';
import { notifications } from './tables.ts';
import { unreadCount, unreadCountQuery } from './unread.ts';
import { filterKinds, notificationKinds, unreadCap, type InboxFilter } from './view.ts';

beforeEach(truncateAll);

const viewerOf = (person: { id: string }) => ({ actorId: person.id, siteRole: 'user' as const });

describe('readInbox filters', () => {
  test('each filter lists exactly its kinds, newest first, and Unread only the unread ones', async () => {
    const w = await seedInboxWorld();
    const me = w.people.author;
    const read = new Date();
    // One read and one unread notice of every kind, oldest first.
    for (const kind of notificationKinds) {
      await seedNotice({ recipientId: me.id, kind, refId: uuidv7(), readAt: read });
      await seedNotice({ recipientId: me.id, kind, refId: uuidv7() });
    }
    await seedNotice({ recipientId: w.people.reader.id, kind: 'reply', refId: uuidv7() });

    const kindsOf = async (filter: InboxFilter) => (await readInbox(viewerOf(me), { filter })).items.map((item) => item.kind);
    const everything = await readInbox(viewerOf(me), { filter: 'all' });
    expect(everything.items).toHaveLength(12);
    expect(everything.items.map((item) => item.id)).toEqual(
      everything.items
        .map((item) => item.id)
        .toSorted()
        .toReversed(),
    );

    for (const filter of ['replies', 'mentions', 'content', 'account'] as const) {
      const kinds = await kindsOf(filter);
      expect(kinds, filter).toHaveLength(2 * filterKinds[filter].length);
      expect(new Set(kinds), filter).toEqual(new Set(filterKinds[filter]));
    }
    const unread = await readInbox(viewerOf(me), { filter: 'unread' });
    expect(unread.items).toHaveLength(6);
    expect(unread.items.every((item) => !item.read)).toBe(true);
    expect(everything.unread).toBe(6);
    expect(everything.unreadByGroup).toEqual({ replies: 1, mentions: 1, content: 2, account: 2 });
  });

  test('pages by the last id: a notice that arrives between pages does not move them', async () => {
    const w = await seedInboxWorld();
    const me = w.people.author;
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push((await seedNotice({ recipientId: me.id, kind: 'reply', refId: uuidv7() })).id);
    const first = await readInbox(viewerOf(me), { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[4], ids[3]]);
    expect(first.next).toBe(ids[3]);

    await seedNotice({ recipientId: me.id, kind: 'mention', refId: uuidv7() });
    const second = await readInbox(viewerOf(me), { limit: 2, cursor: first.next });
    expect(second.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    const third = await readInbox(viewerOf(me), { limit: 2, cursor: second.next });
    expect(third.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(third.next).toBeNull();
    // A cursor that is not an id is the first page.
    expect((await readInbox(viewerOf(me), { limit: 2, cursor: 'nonsense' })).items).toHaveLength(2);
  });

  test('another person’s notices are never listed', async () => {
    const w = await seedInboxWorld();
    await seedNotice({ recipientId: w.people.reader.id, kind: 'reply', refId: uuidv7() });
    expect((await readInbox(viewerOf(w.people.author))).items).toEqual([]);
  });
});

describe('what a row shows', () => {
  test('the actor, the community, the post and a short plain excerpt', async () => {
    const w = await seedInboxWorld();
    const post = await seedPost(w.instances.local, w.communities.open, w.people.author, { title: 'The post' });
    const comment = await seedComment(w.instances.local, post, w.people.reader, { bodyMd: 'Hello **there**, <b>friend</b>' });
    const reply = await seedComment(w.instances.local, post, w.people.reader, { parentId: comment.id, bodyMd: 'A reply' });
    await seedNotice({
      recipientId: w.people.author.id,
      kind: 'reply',
      refId: comment.id,
      actorId: w.people.reader.id,
      communityId: w.communities.open.id,
      postId: post.id,
      commentId: comment.id,
    });
    await seedNotice({
      recipientId: w.people.moderator.id,
      kind: 'reply',
      refId: reply.id,
      actorId: w.people.remoteAuthor.id,
      communityId: w.communities.open.id,
      postId: post.id,
      commentId: reply.id,
    });
    const [item] = (await readInbox(viewerOf(w.people.author))).items;
    expect(item).toMatchObject({
      kind: 'reply',
      read: false,
      actor: { name: 'reader', handle: 'reader', local: true },
      community: { name: 'open', handle: 'open' },
      postId: post.id,
      commentId: comment.id,
      postTitle: 'The post',
      about: 'comment',
      replyTo: 'post',
      withheld: null,
      excerpt: 'Hello there, <b>friend</b>',
      statement: null,
    });
    const [nested] = (await readInbox(viewerOf(w.people.moderator))).items;
    expect(nested).toMatchObject({ replyTo: 'comment', actor: { handle: 'remote_author@lemmy.test', local: false } });
  });

  test('sensitive content shows no text for anyone, and a removed or deleted comment shows that word', async () => {
    const w = await seedInboxWorld();
    const me = w.people.author;
    const notice = (comment: { id: string; postId: string }, extra: Partial<typeof notifications.$inferInsert> = {}) =>
      seedNotice({ recipientId: me.id, kind: 'reply', refId: comment.id, postId: comment.postId, commentId: comment.id, ...extra });

    const plain = await seedPost(w.instances.local, w.communities.open, me, { title: 'Plain' });
    const sensitive = await seedPost(w.instances.local, w.communities.open, me, { title: 'Secret title', sensitive: true });
    const nsfl = await seedPost(w.instances.local, w.communities.open, me, { title: 'Worse title', nsfl: true });
    const gated = await seedActor(w.instances.local, 'Group', 'adults', { sensitive: true });
    const inGated = await seedPost(w.instances.local, gated, me, { title: 'Gated title' });

    const live = await seedComment(w.instances.local, plain, w.people.reader, { bodyMd: 'Visible words' });
    const removed = await seedComment(w.instances.local, plain, w.people.reader, { bodyMd: 'Removed words', removedAt: new Date() });
    const deleted = await seedComment(w.instances.local, plain, w.people.reader, { bodyMd: 'Deleted words', deletedAt: new Date() });
    await notice(live);
    await notice(removed);
    await notice(deleted);
    for (const post of [sensitive, nsfl, inGated]) {
      const comment = await seedComment(w.instances.local, post, w.people.reader, { bodyMd: 'Hidden words' });
      await notice(comment);
    }
    // A mention in a sensitive post itself, and a removed post.
    await seedNotice({ recipientId: me.id, kind: 'mention', refId: sensitive.id, postId: sensitive.id });
    const removedPost = await seedPost(w.instances.local, w.communities.open, me, {
      title: 'Gone',
      bodyMd: 'Gone words',
      removedAt: new Date(),
    });
    await seedNotice({ recipientId: me.id, kind: 'mod_remove', refId: removedPost.id, postId: removedPost.id });

    const items = (await readInbox(viewerOf(me))).items.toReversed();
    expect(items.map((item) => [item.withheld, item.excerpt, item.postTitle])).toEqual([
      [null, 'Visible words', 'Plain'],
      ['removed', null, 'Plain'],
      ['deleted', null, 'Plain'],
      ['sensitive', null, null],
      ['sensitive', null, null],
      ['sensitive', null, null],
      ['sensitive', null, null],
      ['removed', null, 'Gone'],
    ]);
  });

  test('a removal shows the statement of reasons, withheld when the moderator’s instance is not trusted', async () => {
    const w = await seedInboxWorld();
    const me = w.people.author;
    const post = await seedPost(w.instances.local, w.communities.open, me);
    const local = await seedModlog(w.people.moderator, me, {
      action: 'mod.remove',
      communityId: w.communities.open.id,
      communityApId: w.communities.open.apId,
      targetPostId: post.id,
      targetApId: post.apId,
      reason: 'Rule 2',
      authority: { kind: 'local-role', actorId: w.people.moderator.id, role: 'moderator', communityId: w.communities.open.id },
    });
    const remote = await seedModlog(w.people.remoteAuthor, me, {
      action: 'mod.ban',
      reason: 'Because',
      public: false,
      authority: { kind: 'owner', actorId: w.people.remoteAuthor.id },
    });
    await seedNotice({
      recipientId: me.id,
      kind: 'mod_remove',
      refId: local.id,
      modlogId: local.id,
      postId: post.id,
      actorId: w.people.moderator.id,
    });
    await seedNotice({ recipientId: me.id, kind: 'ban', refId: remote.id, modlogId: remote.id, actorId: w.people.remoteAuthor.id });

    const [ban, removal] = (await readInbox(viewerOf(me))).items;
    expect(removal?.statement).toEqual({ modlogId: local.id, reason: 'Rule 2', reasonWithheld: false, public: true });
    expect(ban?.statement).toEqual({ modlogId: remote.id, reason: null, reasonWithheld: true, public: false });
    expect(ban).toMatchObject({ about: null, withheld: null, excerpt: null });
  });

  test('a notice in a deleted or removed community is not listed', async () => {
    const w = await seedInboxWorld();
    const me = w.people.author;
    const gone = await seedActor(w.instances.local, 'Group', 'gone', { deletedAt: new Date() });
    for (const community of [w.communities.open, w.communities.removed, gone]) {
      await seedNotice({ recipientId: me.id, kind: 'ban', refId: uuidv7(), communityId: community.id });
    }
    await seedNotice({ recipientId: me.id, kind: 'ban', refId: uuidv7() });
    const { items } = await readInbox(viewerOf(me));
    expect(items.map((item) => item.community?.name ?? null)).toEqual([null, 'open']);
  });
});

describe('blocks', () => {
  test('a block made after the notice hides a reply and a mention from the list and the count, never a removal or a ban', async () => {
    const w = await seedInboxWorld();
    const me = w.people.author;
    const from = { actorId: w.people.reader.id, communityId: w.communities.open.id };
    for (const kind of ['reply', 'mention', 'mod_remove', 'ban'] as const) {
      await seedNotice({ recipientId: me.id, kind, refId: uuidv7(), ...from });
    }
    await seedNotice({ recipientId: me.id, kind: 'reply', refId: uuidv7(), actorId: w.people.moderator.id });
    expect(await unreadCount(me.id)).toBe(5);

    await seedBlock(me, w.people.reader);
    const inbox = await readInbox(viewerOf(me));
    expect(inbox.items.map((item) => item.kind)).toEqual(['reply', 'ban', 'mod_remove']);
    expect(inbox.unread).toBe(3);
    expect(inbox.unreadByGroup).toEqual({ replies: 1, mentions: 0, content: 1, account: 1 });
    expect(await unreadCount(me.id)).toBe(3);

    // Blocking the community or the instance the author lives on hides the rest of the replies the same way.
    await seedBlock(me, w.communities.open);
    expect((await readInbox(viewerOf(me))).items.map((item) => item.kind)).toEqual(['reply', 'ban', 'mod_remove']);
    await seedBlock(me, { instance: w.instances.local });
    expect((await readInbox(viewerOf(me))).items.map((item) => item.kind)).toEqual(['ban', 'mod_remove']);
  });
});

describe('unreadCount', () => {
  test('is 0 signed out, counts unread only, and stops at the cap', async () => {
    const w = await seedInboxWorld();
    const me = w.people.author.id;
    expect(await unreadCount(null)).toBe(0);
    expect(await unreadCount(me)).toBe(0);
    await seedNotice({ recipientId: me, kind: 'reply', refId: uuidv7(), readAt: new Date() });
    await seedNotice({ recipientId: me, kind: 'reply', refId: uuidv7() });
    expect(await unreadCount(me)).toBe(1);
    await writer().execute(
      sql`insert into notifications (id, recipient_id, kind, ref_id) select gen_random_uuid(), ${me}::uuid, 'mention', gen_random_uuid() from generate_series(1, ${unreadCap + 20})`,
    );
    expect(await unreadCount(me)).toBe(unreadCap);
    expect((await readInbox(viewerOf(w.people.author))).unread).toBe(unreadCap);
    expect(await unreadCount(w.people.reader.id)).toBe(0);
  });
});

describe('at scale', () => {
  test('the unread count reads the unread index only, and a page of the inbox is quick', { timeout: 60_000 }, async () => {
    const w = await seedInboxWorld();
    const people = [
      w.people.author,
      ...(await Promise.all(Array.from({ length: 199 }, (_, n) => seedActor(w.instances.local, 'Person', `bulk${n}`)))),
    ];
    const ids = people.map((person) => person.id);
    // 20,000 notices over 200 people, 1 in 20 unread.
    await writer().execute(
      sql`insert into notifications (id, recipient_id, kind, ref_id, read_at)
        select gen_random_uuid(), (${sql.raw(`array[${ids.map((id) => `'${id}'`).join(',')}]::uuid[]`)})[1 + n % 200],
          (array['reply','mention','mod_remove','mod_restore','ban','unban'])[1 + n % 6], gen_random_uuid(),
          case when n % 20 = 0 then null else now() end
        from generate_series(1, 20000) n`,
    );
    await writer().execute(sql`analyze notifications`);

    const plan = await db().execute<{ 'QUERY PLAN': string }>(sql`explain ${unreadCountQuery(db(), people[0]!.id)}`);
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toContain('notifications_unread');
    expect(text).not.toMatch(/Seq Scan on notifications/);

    // p95 of 50 pages; the best of three rounds, so another process's burst on a shared machine does not decide it.
    const rounds: number[] = [];
    for (let round = 0; round < 3; round++) {
      const times: number[] = [];
      for (let n = 0; n < 50; n++) {
        const started = performance.now();
        await readInbox(viewerOf(people[(round * 50 + n) % people.length]!), { filter: n % 2 === 0 ? 'all' : 'unread' });
        times.push(performance.now() - started);
      }
      rounds.push(times.toSorted((a, b) => a - b)[Math.floor(times.length * 0.95)]!);
    }
    const p95 = Math.min(...rounds);
    expect(p95).toBeLessThan(50);
  });
});
