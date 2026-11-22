import type { Principal } from '@peblish/schema/authz';
import { parseEvent } from '@peblish/schema/events';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { gateOf } from '../communities/gate.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts, votes } from '../db/tables/content.ts';
import { follows } from '../db/tables/follows.ts';
import { outboxCursors } from '../db/tables/outbox.ts';
import { writer } from '../db/write.ts';
import { acceptFollow } from '../follows/follow.ts';
import { followAs } from '../follows/service.ts';
import { deleteAccount } from '../identity/delete.ts';
import { removeContent } from '../moderation/remove.ts';
import { peerControls } from '../peers/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents, seedBan, seedComment, seedPost } from '../testing/seed-az.ts';
import { declareAge } from '../testing/seed-b1.ts';
import { seedBlock } from '../testing/seed-e1.ts';
import { drainNotices, emitEvent, kindsOf, noticeCount, noticesOf, remoteSay, say, seedInboxWorld } from '../testing/seed-e2.ts';
import { localUser, seedActor } from '../testing/seed.ts';
import { outboxEmitter } from '../tx/tx.ts';
import { threadWatches } from '../watches/tables.ts';
import { threadFollowersOf, threadReplyFanOut } from '../watches/watchers.ts';
import { watchThreadAs } from '../watches/watches.ts';
import { consumer } from './consumer.ts';
import { readInbox } from './read.ts';
import { notifications } from './tables.ts';
import { inboxFilters } from './view.ts';
import { markAllNotificationsReadAs } from './service.ts';
import { unreadCount } from './unread.ts';

// The two notice kinds of branch 5 (lane f-notify), written by the real consumer from the real
// mutations: `thread_reply` for a followed thread's new comment, `follow_accept` for a remote
// community's Accept.

vi.setConfig({ testTimeout: 60_000 });
beforeEach(truncateAll);

const follow = async (person: { id: string }, postId: string) => {
  const result = await watchThreadAs(localUser(person.id), { postId });
  if (!result.ok) throw new Error(result.reason);
};
const createdEvents = async () => (await outboxEvents()).map(parseEvent).filter((event) => event.type === 'notification.created');

describe('thread_reply', () => {
  test('a new comment in a followed thread tells each follower once, never its author or a follow newer than it', async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    await follow(w.people.reader, postId);
    await follow(w.people.moderator, postId);
    const id = await say(w.people.owner, postId, 'A new thought');
    const own = await say(w.people.reader, postId, 'My own');
    await follow(w.people.admin, postId); // after both comments: hears of neither
    await drainNotices();

    expect(await noticesOf(w.people.reader.id)).toMatchObject([
      { kind: 'thread_reply', refId: id, actorId: w.people.owner.id, postId, commentId: id, communityId: w.communities.open.id },
    ]);
    expect(await noticesOf(w.people.moderator.id)).toMatchObject([
      { kind: 'thread_reply', refId: id },
      { kind: 'thread_reply', refId: own },
    ]);
    expect(await kindsOf(w.people.admin.id)).toEqual([]);
    // The post's author, who follows nothing, has the replies as before.
    expect(await kindsOf(w.people.author.id)).toEqual(['reply', 'reply']);
  });

  test('never a second notice for a comment that made a reply or a mention for that person', async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    await follow(w.people.author, postId);
    await follow(w.people.moderator, postId);
    await follow(w.people.owner, postId);
    const id = await say(w.people.reader, postId, 'Asking @moderator@feddit.test');
    await drainNotices();
    expect(await noticesOf(w.people.author.id)).toMatchObject([{ kind: 'reply', refId: id }]);
    expect(await noticesOf(w.people.moderator.id)).toMatchObject([{ kind: 'mention', refId: id }]);
    expect(await noticesOf(w.people.owner.id)).toMatchObject([{ kind: 'thread_reply', refId: id }]);
    expect(await noticeCount()).toBe(3);
  });

  test('a follower who blocks the author or the community, a closed or gone comment and sensitive content for the undeclared tell nobody', async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    for (const person of [w.people.reader, w.people.moderator, w.people.owner]) await follow(person, postId);
    await seedBlock(w.people.reader, w.people.admin);
    await seedBlock(w.people.moderator, w.communities.open);
    await say(w.people.admin, postId, 'Hello all');
    await drainNotices();
    expect(await kindsOf(w.people.reader.id)).toEqual([]);
    expect(await kindsOf(w.people.moderator.id)).toEqual([]);
    expect(await kindsOf(w.people.owner.id)).toEqual(['thread_reply']);

    // A comment on a removed post, and a removed or deleted comment, as the inbound path stores them.
    await writer()
      .insert(threadWatches)
      .values({ ownerId: w.people.owner.id, postId: w.posts.local.removed, since: new Date(0) });
    const post = { id: w.posts.local.removed };
    const underRemoved = await seedComment(w.instances.local, post, w.people.admin);
    const removed = await seedComment(w.instances.local, { id: postId }, w.people.admin, { removedAt: new Date() });
    const deleted = await seedComment(w.instances.local, { id: postId }, w.people.admin, { deletedAt: new Date() });
    for (const [comment, onPost] of [
      [underRemoved, post.id],
      [removed, postId],
      [deleted, postId],
    ] as const) {
      await emitEvent({
        type: 'comment.created',
        v: 1,
        commentId: comment.id,
        postId: onPost,
        authorId: w.people.admin.id,
        local: true,
        parentId: null,
      });
    }
    await drainNotices();
    expect(await kindsOf(w.people.owner.id)).toEqual(['thread_reply']);

    // Sensitive: only a follower who declared 16+ hears of it. The commenter has declared too, as the
    // age gate on writes asks of anyone who comments there.
    const sensitive = await seedPost(w.instances.local, w.communities.open, w.people.author, { sensitive: true });
    await declareAge(w.people.owner);
    await declareAge(w.people.admin);
    await follow(w.people.owner, sensitive.id);
    await writer()
      .insert(threadWatches)
      .values({ ownerId: w.people.reader.id, postId: sensitive.id, since: new Date(0) });
    await say(w.people.admin, sensitive.id, 'Careful');
    await drainNotices();
    expect(await kindsOf(w.people.owner.id)).toEqual(['thread_reply', 'thread_reply']);
    expect(await kindsOf(w.people.reader.id)).toEqual([]);
  });

  test('a comment whose author deletes the account before its notices go out tells no follower, then or on a replay', async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    await follow(w.people.reader, postId);
    await say(w.people.owner, postId, 'Gone soon');
    const decision = await authorize('account.delete', localUser(w.people.owner.id), { actorId: w.people.owner.id });
    if (!decision.ok) throw new Error(decision.reason);
    await deleteAccount(decision.grant, { reason: 'owner request' });
    await drainNotices();
    expect(await kindsOf(w.people.reader.id)).toEqual([]);
    await writer().update(outboxCursors).set({ txId: '0', eventId: 0 }).where(eq(outboxCursors.consumer, 'notifications.create'));
    await drainNotices();
    expect(await kindsOf(w.people.reader.id)).toEqual([]);
  });

  test("a notice naming a deleted commenter that lands after the account's clean-up is never listed, and the deletion's consumer clears it", async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    await follow(w.people.reader, postId);
    const theirs = await say(w.people.owner, postId, 'Gone soon');
    const kept = await say(w.people.admin, postId, 'Staying');
    const decision = await authorize('account.delete', localUser(w.people.owner.id), { actorId: w.people.owner.id });
    if (!decision.ok) throw new Error(decision.reason);
    await deleteAccount(decision.grant, { reason: 'owner request' });
    // The fan-out chose its followers while the account was live, and its insert commits after the deletion's clean-up.
    await writer().insert(notifications).values({
      recipientId: w.people.reader.id,
      kind: 'thread_reply',
      refId: theirs,
      actorId: w.people.owner.id,
      communityId: w.communities.open.id,
      postId,
      commentId: theirs,
    });
    const viewer = { actorId: w.people.reader.id, siteRole: 'user' } as const;
    expect([(await readInbox(viewer)).items, await unreadCount(w.people.reader.id)]).toEqual([[], 0]);

    await drainNotices();
    expect((await noticesOf(w.people.reader.id)).map((notice) => notice.refId)).toEqual([kept]);
    expect((await readInbox(viewer)).items).toMatchObject([{ kind: 'thread_reply', actor: { id: w.people.admin.id }, commentId: kept }]);
  });

  test("a live commenter's fan-out does not wait on another write holding their account row", async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    await follow(w.people.reader, postId);
    const id = await say(w.people.owner, postId, 'A busy account');
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = writer().transaction(async (t) => {
      await t.execute(sql`select 1 from actors where id = ${w.people.owner.id}::uuid for no key update`);
      locked();
      await released;
    });
    await holding;
    try {
      // The consumer's own handler, in a transaction that fails instead of waiting on a lock (the worker's horizon is the
      // whole server's, so its timing proves nothing here).
      await writer().transaction(async (db) => {
        await db.execute(sql`set local lock_timeout = '2s'`);
        const event = {
          type: 'comment.created',
          v: 1,
          commentId: id,
          postId,
          authorId: w.people.owner.id,
          local: true,
          parentId: null,
        } as const;
        await consumer.handle(event, { db, emit: outboxEmitter(db).emit });
      });
    } finally {
      release();
      await holder;
    }
    expect(await kindsOf(w.people.reader.id)).toEqual(['thread_reply']);
  });

  test('a replay of the same event writes nothing more and emits nothing more', async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    await follow(w.people.reader, postId);
    await follow(w.people.moderator, postId);
    const id = await say(w.people.owner, postId, 'Once');
    await drainNotices();
    expect(await noticeCount()).toBe(3); // the author's reply and two thread replies
    const emitted = (await createdEvents()).length;

    // The same event again, and the whole outbox replayed from the start.
    await emitEvent({ type: 'comment.created', v: 1, commentId: id, postId, authorId: w.people.owner.id, local: true, parentId: null });
    await drainNotices();
    await writer().update(outboxCursors).set({ txId: '0', eventId: 0 }).where(eq(outboxCursors.consumer, 'notifications.create'));
    await drainNotices();
    expect(await noticeCount()).toBe(3);
    expect(await kindsOf(w.people.reader.id)).toEqual(['thread_reply']);
    expect((await createdEvents()).length).toBe(emitted);
  });

  test(`at most ${threadReplyFanOut} followers, the earliest first`, async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    const many = [];
    for (let n = 0; n <= threadReplyFanOut; n++) many.push(await seedActor(w.instances.local, 'Person', `follower_${n}`));
    await writer()
      .insert(threadWatches)
      .values(many.map((person, n) => ({ ownerId: person.id, postId, since: new Date(Date.UTC(2026, 0, 1, 0, 0, n)) })));
    const comment = await seedComment(w.instances.local, { id: postId }, w.people.reader);
    const told = await threadFollowersOf(db(), comment.id, []);
    expect(told).toHaveLength(threadReplyFanOut);
    expect(told).toEqual(many.slice(0, threadReplyFanOut).map((person) => person.id));
  });

  test("a follower who blocks the post's author is not told, and a later block of it, or a later flag, hides a notice already sent", async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    for (const person of [w.people.reader, w.people.moderator, w.people.owner]) await follow(person, postId);
    await declareAge(w.people.owner);
    await seedBlock(w.people.reader, w.people.author); // the post's author, not the commenter
    await say(w.people.admin, postId, 'About this post');
    await drainNotices();
    expect(await kindsOf(w.people.reader.id)).toEqual([]);
    expect(await kindsOf(w.people.moderator.id)).toEqual(['thread_reply']);
    expect(await kindsOf(w.people.owner.id)).toEqual(['thread_reply']);
    // A replay tells the eligible followers nothing more.
    await writer().update(outboxCursors).set({ txId: '0', eventId: 0 }).where(eq(outboxCursors.consumer, 'notifications.create'));
    await drainNotices();
    expect(await kindsOf(w.people.moderator.id)).toEqual(['thread_reply']);

    const shown = async (person: { id: string }) => {
      const inbox = await readInbox({ actorId: person.id, siteRole: 'user' });
      return [inbox.items.length, inbox.unread, inbox.unreadByGroup.replies, await unreadCount(person.id)];
    };
    // A locked thread and a ban from the community still let a follower read: nothing changes.
    await writer().update(posts).set({ locked: true }).where(eq(posts.id, postId));
    await seedBan(w.communities.open, w.people.moderator);
    expect(await shown(w.people.moderator)).toEqual([1, 1, 1, 1]);
    // The moderator blocks the post's author after the notice: it goes from the list and every count.
    await seedBlock(w.people.moderator, w.people.author);
    expect(await shown(w.people.moderator)).toEqual([0, 0, 0, 0]);

    // The post is flagged sensitive since: no follower has it any more, declared or not; unflagged, it is back.
    const other = await seedPost(w.instances.local, w.communities.open, w.people.admin);
    await follow(w.people.reader, other.id);
    await follow(w.people.owner, other.id);
    await say(w.people.admin, other.id, 'Before the flag');
    await drainNotices();
    expect(await shown(w.people.reader)).toEqual([1, 1, 1, 1]);
    await writer().update(posts).set({ sensitive: true }).where(eq(posts.id, other.id));
    expect(await shown(w.people.reader)).toEqual([0, 0, 0, 0]);
    expect(await shown(w.people.owner)).toEqual([1, 1, 1, 1]);
    await writer().update(posts).set({ sensitive: false }).where(eq(posts.id, other.id));
    expect(await shown(w.people.owner)).toEqual([2, 2, 2, 2]);
  });

  test('a replay after an early follower unfollowed tells no follower past the limit', async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    const many = [];
    for (let n = 0; n <= threadReplyFanOut; n++) many.push(await seedActor(w.instances.local, 'Person', `replayed_${n}`));
    await writer()
      .insert(threadWatches)
      .values(many.map((person, n) => ({ ownerId: person.id, postId, since: new Date(Date.UTC(2026, 0, 1, 0, 0, n)) })));
    const id = await say(w.people.reader, postId, 'To the many');
    await drainNotices();
    const last = many.at(-1)!;
    expect(await kindsOf(last.id)).toEqual([]);
    const told = await noticeCount();

    await writer()
      .delete(threadWatches)
      .where(and(eq(threadWatches.ownerId, many[0]!.id), eq(threadWatches.postId, postId)));
    await emitEvent({ type: 'comment.created', v: 1, commentId: id, postId, authorId: w.people.reader.id, local: true, parentId: null });
    await drainNotices();
    await writer().update(outboxCursors).set({ txId: '0', eventId: 0 }).where(eq(outboxCursors.consumer, 'notifications.create'));
    await drainNotices();
    expect(await kindsOf(last.id)).toEqual([]);
    expect(await noticeCount()).toBe(told);
  });

  test('a later block of its author hides it from the list and every count', async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    await follow(w.people.reader, postId);
    const id = await say(w.people.owner, postId, 'Visible words');
    await drainNotices();
    const viewer = { actorId: w.people.reader.id, siteRole: 'user' } as const;
    const inbox = await readInbox(viewer);
    expect(inbox.items).toMatchObject([
      { kind: 'thread_reply', actor: { id: w.people.owner.id }, commentId: id, excerpt: 'Visible words' },
    ]);
    expect([inbox.unread, inbox.unreadByGroup.replies, inbox.unreadByGroup.account]).toEqual([1, 1, 0]);

    await seedBlock(w.people.reader, w.people.owner);
    expect((await readInbox(viewer)).items).toEqual([]);
    expect(await unreadCount(w.people.reader.id)).toBe(0);
  });

  test.each(['removed', 'deleted', 'purged'] as const)(
    'a notice whose comment is %s is left out of the list and every count, so blocking its author changes nothing',
    async (state) => {
      const w = await seedInboxWorld();
      const postId = w.posts.local.normal;
      await follow(w.people.reader, postId);
      const id = await say(w.people.owner, postId, 'Words to withhold');
      const kept = await say(w.people.admin, postId, 'Words that stay');
      await drainNotices();
      if (state === 'removed') {
        const moderator = { kind: 'local', actorId: w.people.moderator.id, siteRole: 'user' } as const;
        await removeContent(await grantFor('mod.remove', moderator, { target: { kind: 'comment', id } }), { reason: 'Rule 2' });
        await drainNotices();
      } else if (state === 'deleted') {
        await writer().update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, id));
      } else {
        // Purged outright: its votes go first (they hold a key to it), then the row; the notice's comment_id goes null.
        await writer().delete(votes).where(eq(votes.commentId, id));
        await writer().delete(comments).where(eq(comments.id, id));
      }
      const viewer = { actorId: w.people.reader.id, siteRole: 'user' } as const;
      const before = await readInbox(viewer);
      expect(before.items).toMatchObject([{ kind: 'thread_reply', actor: { id: w.people.admin.id }, commentId: kept }]);
      expect(before.items).toHaveLength(1);
      expect([before.unread, before.unreadByGroup.replies, await unreadCount(w.people.reader.id)]).toEqual([1, 1, 1]);

      await seedBlock(w.people.reader, w.people.owner);
      expect(await readInbox(viewer)).toEqual(before);
      expect(await unreadCount(w.people.reader.id)).toBe(1);

      // The post's author keeps both replies, and a removal tells the comment's author why, as before.
      expect(await kindsOf(w.people.author.id)).toEqual(['reply', 'reply']);
      if (state === 'removed') {
        const own = await readInbox({ actorId: w.people.owner.id, siteRole: 'user' }, { filter: 'content' });
        expect(own.items).toMatchObject([{ kind: 'mod_remove', statement: { reason: 'Rule 2' } }]);
      }
    },
  );

  test('a followed thread on flagged content is listed for nobody, a declared reader too, so a block of its commenter changes nothing', async () => {
    const w = await seedInboxWorld();
    // The commenter declared 16+ as well: the age gate on writes takes no comment there otherwise.
    for (const person of [w.people.reader, w.people.owner]) await declareAge(person);
    const flagged = await seedPost(w.instances.local, w.communities.open, w.people.author, { sensitive: true });
    await follow(w.people.reader, flagged.id);
    await follow(w.people.reader, w.posts.local.normal);
    await say(w.people.owner, flagged.id, 'Careful words');
    const kept = await say(w.people.admin, w.posts.local.normal, 'Plain words');
    // The reader's own comment there, removed with a reason: a moderator's notice is owed, flagged or not.
    const own = await say(w.people.reader, flagged.id, 'Off topic');
    const moderator = { kind: 'local', actorId: w.people.moderator.id, siteRole: 'user' } as const;
    await removeContent(await grantFor('mod.remove', moderator, { target: { kind: 'comment', id: own } }), { reason: 'Rule 4' });
    await drainNotices();
    const viewer = { actorId: w.people.reader.id, siteRole: 'user' } as const;
    // Every filter's rows and its count agree.
    const pages = async () => {
      const all = await readInbox(viewer);
      const counts = { all: all.unread, unread: all.unread, ...all.unreadByGroup };
      const lists = await Promise.all(inboxFilters.map(async (filter) => (await readInbox(viewer, { filter })).items));
      for (const [index, filter] of inboxFilters.entries()) expect(lists[index], filter).toHaveLength(counts[filter]);
      return lists;
    };
    const before = await pages();
    expect(before[0]).toMatchObject([
      { kind: 'mod_remove', statement: { reason: 'Rule 4' } },
      { kind: 'thread_reply', commentId: kept, withheld: null },
    ]);
    await seedBlock(w.people.reader, w.people.owner);
    expect(await pages()).toEqual(before);
  });

  test("a peer this server blocks: its commenter's notice in a local thread leaves rows and counts, nothing new is told, and it comes back unread", async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    const [post] = await db().select({ apId: posts.apId }).from(posts).where(eq(posts.id, postId));
    await follow(w.people.reader, postId);
    const here = await say(w.people.owner, postId, 'From here');
    const there = await remoteSay(w.people.remoteAuthor, post!.apId);
    await drainNotices();
    const viewer = { actorId: w.people.reader.id, siteRole: 'user' } as const;
    const seen = async () => {
      const inbox = await readInbox(viewer);
      return {
        comments: inbox.items.map((item) => [item.commentId, item.read]),
        counts: [inbox.unread, inbox.unreadByGroup.replies, await unreadCount(w.people.reader.id)],
      };
    };
    expect(await seen()).toEqual({
      comments: [
        [there, false],
        [here, false],
      ],
      counts: [2, 2, 2],
    });

    await writer().insert(peerControls).values({ instanceId: w.instances.lemmy.id, blocked: true });
    expect(await seen()).toEqual({ comments: [[here, false]], counts: [1, 1, 1] });
    // A comment from that peer while it is blocked tells nobody.
    const later = await remoteSay(w.people.remoteAuthor, post!.apId);
    await drainNotices();
    expect((await noticesOf(w.people.reader.id)).map((notice) => notice.refId)).not.toContain(later);

    // A locked thread and a ban from the community still read; unblocking brings the notice back, unread.
    await writer().update(posts).set({ locked: true }).where(eq(posts.id, postId));
    await seedBan(w.communities.open, w.people.reader);
    expect(await seen()).toEqual({ comments: [[here, false]], counts: [1, 1, 1] });
    await writer().update(peerControls).set({ blocked: false }).where(eq(peerControls.instanceId, w.instances.lemmy.id));
    expect(await seen()).toEqual({
      comments: [
        [there, false],
        [here, false],
      ],
      counts: [2, 2, 2],
    });
  });
});

describe('follow_accept', () => {
  async function pending(
    w: Awaited<ReturnType<typeof seedInboxWorld>>,
    person: { id: string; apId: string },
    community = w.communities.remote,
  ) {
    const asked = await followAs(localUser(person.id), community.id);
    if (!asked.ok || asked.state !== 'pending') throw new Error('expected a pending follow');
    const [row] = await db()
      .select()
      .from(follows)
      .where(and(eq(follows.followerId, person.id), eq(follows.followeeId, community.id)));
    const remote: Principal = { kind: 'remote', actorId: community.id, announcedBy: null };
    return {
      row: row!,
      accept: async () =>
        acceptFollow(await grantFor('follow.accept', remote, { followApId: row!.apId!, followerApId: person.apId }), undefined),
    };
  }

  test('a remote community’s Accept tells the person once, in the Account group, with the community and nobody as actor', async () => {
    const w = await seedInboxWorld();
    const { row, accept } = await pending(w, w.people.reader);
    expect(await accept()).toEqual({ accepted: true });
    await drainNotices();
    expect(await noticesOf(w.people.reader.id)).toMatchObject([
      { kind: 'follow_accept', refId: row.id, actorId: null, communityId: w.communities.remote.id, postId: null, commentId: null },
    ]);
    const inbox = await readInbox({ actorId: w.people.reader.id, siteRole: 'user' }, { filter: 'account' });
    expect(inbox.items).toMatchObject([{ kind: 'follow_accept', actor: null, community: { id: w.communities.remote.id }, about: null }]);
    expect([inbox.unread, inbox.unreadByGroup.account, inbox.unreadByGroup.replies]).toEqual([1, 1, 0]);

    // A second Accept changes nothing (core skips it), and a replay of the whole outbox writes nothing.
    expect(await accept()).toEqual({ accepted: false });
    await writer().update(outboxCursors).set({ txId: '0', eventId: 0 }).where(eq(outboxCursors.consumer, 'notifications.create'));
    await drainNotices();
    expect(await noticeCount()).toBe(1);
  });

  test('not for a local community, a blocked or closed one, a sensitive one for the undeclared, or a stale accept', async () => {
    const w = await seedInboxWorld();
    expect((await followAs(localUser(w.people.reader.id), w.communities.open.id)).ok).toBe(true); // accepted at once
    const blocked = await pending(w, w.people.moderator);
    await seedBlock(w.people.moderator, w.communities.remote);
    await blocked.accept();
    // Flagged after the request: someone who has not declared 16+ cannot ask to join a flagged community at all.
    const sensitiveGroup = await seedActor(w.instances.lemmy, 'Group', 'spicy');
    const sensitive = await pending(w, w.people.owner, sensitiveGroup);
    await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, sensitiveGroup.id));
    await sensitive.accept();
    const stale = await pending(w, w.people.author);
    await stale.accept();
    await writer()
      .update(follows)
      .set({ acceptedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(follows.id, stale.row.id));
    await drainNotices();
    expect(await noticeCount()).toBe(0);

    // The same sensitive community, for a person who declared 16+.
    await declareAge(w.people.admin);
    const declared = await pending(w, w.people.admin, sensitiveGroup);
    await declared.accept();
    await drainNotices();
    expect(await kindsOf(w.people.admin.id)).toEqual(['follow_accept']);
    // A community deleted since: the notice is neither listed nor counted.
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, sensitiveGroup.id));
    expect(await unreadCount(w.people.admin.id)).toBe(0);
  });

  test('a community on a peer this server blocks: its Accept leaves rows and counts, a late one tells nobody, and unblocking brings it back unread', async () => {
    const w = await seedInboxWorld();
    await (await pending(w, w.people.reader)).accept();
    await drainNotices();
    const seen = async (person: { id: string }) => {
      const inbox = await readInbox({ actorId: person.id, siteRole: 'user' }, { filter: 'account' });
      return [inbox.items.map((item) => item.read), inbox.unread, inbox.unreadByGroup.account, await unreadCount(person.id)];
    };
    expect(await seen(w.people.reader)).toEqual([[false], 1, 1, 1]);
    // Accepted, then the peer is blocked before the consumer reads the Accept.
    await (await pending(w, w.people.moderator)).accept();
    await writer().insert(peerControls).values({ instanceId: w.instances.lemmy.id, blocked: true });
    await drainNotices();
    expect(await kindsOf(w.people.moderator.id)).toEqual([]);
    expect(await seen(w.people.reader)).toEqual([[], 0, 0, 0]);
    await writer().update(peerControls).set({ blocked: false }).where(eq(peerControls.instanceId, w.instances.lemmy.id));
    expect(await seen(w.people.reader)).toEqual([[false], 1, 1, 1]);
  });

  test('a community flagged after its Accept is listed and counted only where the community gate opens it', async () => {
    const w = await seedInboxWorld();
    await declareAge(w.people.admin);
    for (const person of [w.people.reader, w.people.admin]) await (await pending(w, person)).accept();
    await drainNotices();
    const seen = async (person: { id: string }) => {
      const inbox = await readInbox({ actorId: person.id, siteRole: 'user' }, { filter: 'account' });
      return [inbox.items.length, inbox.unread, inbox.unreadByGroup.account, await unreadCount(person.id)];
    };
    for (const flagged of [false, true]) {
      await writer().update(actors).set({ sensitive: flagged }).where(eq(actors.id, w.communities.remote.id));
      for (const [person, declared] of [
        [w.people.reader, false],
        [w.people.admin, true],
      ] as const) {
        const open = gateOf(flagged, { declared }, true) === 'none' ? 1 : 0;
        expect([flagged, declared, ...(await seen(person))]).toEqual([flagged, declared, open, open, open, open]);
      }
    }
    // Mark all read answers only what the inbox showed the undeclared reader: nothing.
    expect(await markAllNotificationsReadAs(localUser(w.people.reader.id))).toEqual({ ok: true, count: 0, batch: null });
  });
});
