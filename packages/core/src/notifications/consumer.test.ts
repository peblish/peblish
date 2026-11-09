import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { outboxCursors } from '../db/tables/outbox.ts';
import { writer } from '../db/write.ts';
import { deleteCommentAs, updateCommentAs } from '../comments/actions.ts';
import { banFromCommunity, unbanFromCommunity } from '../moderation/ban.ts';
import { removeContent, restoreContent } from '../moderation/remove.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, seedPost } from '../testing/seed-az.ts';
import {
  drainNotices,
  emitEvent,
  kindsOf,
  noticeCount,
  noticesOf,
  remoteSay,
  say,
  seedInboxWorld,
  seedModlog,
  seedNotice,
} from '../testing/seed-e2.ts';
import { seedBlock } from '../testing/seed-e1.ts';
import { localUser } from '../testing/seed.ts';
import { db } from '../db/read.ts';
import { notifications } from './tables.ts';
import { uuidv7 } from 'uuidv7';

beforeEach(truncateAll);

const postApId = async (postId: string) => (await db().select({ apId: posts.apId }).from(posts).where(eq(posts.id, postId)))[0]!.apId;
const commentApId = async (id: string) => (await db().select({ apId: comments.apId }).from(comments).where(eq(comments.id, id)))[0]!.apId;

describe('replies', () => {
  test('a reply to a post tells the post’s author, from a local and from a remote author', async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    const local = await say(w.people.reader, postId, 'Nice post');
    const remote = await remoteSay(w.people.remoteAuthor, await postApId(postId));
    await drainNotices();

    const rows = await noticesOf(w.people.author.id);
    expect(rows.map((row) => [row.kind, row.refId, row.actorId, row.postId, row.commentId, row.communityId, row.readAt])).toEqual([
      ['reply', local, w.people.reader.id, postId, local, w.communities.open.id, null],
      ['reply', remote, w.people.remoteAuthor.id, postId, remote, w.communities.open.id, null],
    ]);
    expect(await noticeCount()).toBe(2);
  });

  test('a reply to a comment tells the comment’s author, local or remote, and nobody else', async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    const parent = await say(w.people.moderator, postId, 'First');
    const local = await say(w.people.reader, postId, 'Second', parent);
    const remote = await remoteSay(w.people.remoteAuthor, await commentApId(parent));
    await drainNotices();

    expect(await noticesOf(w.people.moderator.id)).toMatchObject([
      { kind: 'reply', refId: local, commentId: local },
      { kind: 'reply', refId: remote, commentId: remote },
    ]);
    // The first two comments also reply to the post's author.
    expect(await kindsOf(w.people.author.id)).toEqual(['reply']);
    expect(await kindsOf(w.people.reader.id)).toEqual([]);
  });

  test('a remote parent author is not notified', async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.remote.normal;
    await say(w.people.reader, postId, 'Hello Lemmy');
    await drainNotices();
    expect(await noticeCount()).toBe(0);
  });

  test('self-replies, deleted or removed comments and a comment 8 days old notify nobody', async () => {
    const w = await seedInboxWorld();
    const postId = w.posts.local.normal;
    await say(w.people.author, postId, 'Talking to myself');
    const deleted = await say(w.people.reader, postId, 'Oops');
    expect((await deleteCommentAs(localUser(w.people.reader.id), deleted)).ok).toBe(true);
    const removed = await say(w.people.reader, postId, 'Rude');
    await writer().update(comments).set({ removedAt: new Date() }).where(eq(comments.id, removed));
    const old = await say(w.people.reader, postId, 'From last week');
    await writer()
      .update(comments)
      .set({ publishedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(comments.id, old));
    await drainNotices();
    expect(await noticeCount()).toBe(0);

    // A comment 6 days old still counts.
    const recent = await say(w.people.reader, postId, 'From this week');
    await writer()
      .update(comments)
      .set({ publishedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000) })
      .where(eq(comments.id, recent));
    await drainNotices();
    expect(await kindsOf(w.people.author.id)).toEqual(['reply']);
  });

  test('a notice for a recipient who has since been deleted is not written', async () => {
    const w = await seedInboxWorld();
    await say(w.people.reader, w.posts.local.normal, 'Hi');
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, w.people.author.id));
    await drainNotices();
    expect(await noticeCount()).toBe(0);
  });
});

describe('mentions', () => {
  test('a reply that also mentions the post’s author is one mention', async () => {
    const w = await seedInboxWorld();
    const id = await say(w.people.reader, w.posts.local.normal, 'Thanks @author@feddit.test');
    await drainNotices();
    expect(await noticesOf(w.people.author.id)).toMatchObject([{ kind: 'mention', refId: id }]);
  });

  test('a comment notifies each person it mentions, a post too, and never the writer', async () => {
    const w = await seedInboxWorld();
    const id = await say(
      w.people.reader,
      w.posts.local.normal,
      'cc @moderator@feddit.test @reader@feddit.test @nobody@feddit.test @x@lemmy.test',
    );
    await drainNotices();
    expect(await noticesOf(w.people.moderator.id)).toMatchObject([{ kind: 'mention', refId: id }]);
    expect(await kindsOf(w.people.reader.id)).toEqual([]);

    // A remote post carries its mentions as tags; a bare @name is only text.
    const post = await seedPost(w.instances.lemmy, w.communities.remote, w.people.remoteAuthor, {
      raw: { tag: [{ type: 'Mention', href: w.people.owner.apId, name: '@owner@feddit.test' }] },
      bodyMd: 'hi @reader',
    });
    await emitEvent({
      type: 'post.created',
      v: 1,
      postId: post.id,
      communityId: w.communities.remote.id,
      authorId: w.people.remoteAuthor.id,
      local: false,
    });
    await drainNotices();
    expect(await noticesOf(w.people.owner.id)).toMatchObject([{ kind: 'mention', refId: post.id, postId: post.id, commentId: null }]);
    expect(await kindsOf(w.people.reader.id)).toEqual([]);
  });

  test('an edit that adds a mention adds one notice, and a repeat or a replay adds none', async () => {
    const w = await seedInboxWorld();
    const reader = localUser(w.people.reader.id);
    const id = await say(w.people.reader, w.posts.local.normal, 'Plain');
    await drainNotices();
    expect(await noticeCount()).toBe(1); // the reply to the author

    expect((await updateCommentAs(reader, id, { bodyMd: 'Now with @moderator@feddit.test' })).ok).toBe(true);
    await drainNotices();
    expect(await kindsOf(w.people.moderator.id)).toEqual(['mention']);
    expect(await noticeCount()).toBe(2);

    expect((await updateCommentAs(reader, id, { bodyMd: 'Again @moderator@feddit.test, edited' })).ok).toBe(true);
    await drainNotices();
    expect(await noticeCount()).toBe(2);

    // Replaying the whole outbox from the start writes nothing new.
    await writer().update(outboxCursors).set({ txId: '0', eventId: 0 }).where(eq(outboxCursors.consumer, 'notifications.create'));
    await drainNotices();
    expect(await noticeCount()).toBe(2);
  });

  test('a mention in a post written this week notifies, one older than a week does not', async () => {
    const w = await seedInboxWorld();
    const fresh = await seedPost(w.instances.local, w.communities.open, w.people.author, { bodyMd: 'hey @reader@feddit.test' });
    const old = await seedPost(w.instances.local, w.communities.open, w.people.author, {
      bodyMd: 'hey @moderator@feddit.test',
      publishedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    for (const post of [fresh, old]) {
      await emitEvent({ type: 'post.created', v: 1, postId: post.id, communityId: post.communityId, authorId: post.authorId, local: true });
    }
    await drainNotices();
    expect(await kindsOf(w.people.reader.id)).toEqual(['mention']);
    expect(await kindsOf(w.people.moderator.id)).toEqual([]);
  });
});

describe('moderator actions', () => {
  test('a removal and a restore tell the author, naming the modlog row', async () => {
    const w = await seedInboxWorld();
    const mod = localUser(w.people.moderator.id);
    const id = await say(w.people.reader, w.posts.local.normal, 'Rude');
    const target = { kind: 'comment', id } as const;
    const removed = await removeContent(await grantFor('mod.remove', mod, { target }), { reason: 'Rule 2' });
    const restored = await restoreContent(await grantFor('mod.restore', mod, { target }), { reason: 'Mistake' });
    await drainNotices();

    expect(await noticesOf(w.people.reader.id)).toMatchObject([
      { kind: 'mod_remove', refId: removed.modlogId, modlogId: removed.modlogId, actorId: w.people.moderator.id, commentId: id },
      { kind: 'mod_restore', refId: restored.modlogId, modlogId: restored.modlogId, commentId: id },
    ]);
    expect((await noticesOf(w.people.reader.id))[0]).toMatchObject({ postId: w.posts.local.normal, communityId: w.communities.open.id });
  });

  test('a post removal tells the post’s author', async () => {
    const w = await seedInboxWorld();
    const target = { kind: 'post', id: w.posts.local.normal } as const;
    const removed = await removeContent(await grantFor('mod.remove', localUser(w.people.moderator.id), { target }), { reason: 'Spam' });
    await drainNotices();
    expect(await noticesOf(w.people.author.id)).toMatchObject([
      { kind: 'mod_remove', refId: removed.modlogId, postId: target.id, commentId: null },
    ]);
  });

  test('a moderator removing their own content, or a remote person’s, notifies nobody', async () => {
    const w = await seedInboxWorld();
    const mod = localUser(w.people.moderator.id);
    const own = await say(w.people.moderator, w.posts.local.normal, 'Mine');
    await removeContent(await grantFor('mod.remove', mod, { target: { kind: 'comment', id: own } }), {});
    const remoteComment = await remoteSay(w.people.remoteAuthor, await postApId(w.posts.local.normal));
    await removeContent(await grantFor('mod.remove', mod, { target: { kind: 'comment', id: remoteComment } }), {});
    await drainNotices();
    // Only the two replies to the post's author exist; nobody was told about a removal.
    expect(await db().select().from(notifications).where(eq(notifications.kind, 'mod_remove'))).toEqual([]);
  });

  test('a community ban, an unban and a site ban tell the person banned', async () => {
    const w = await seedInboxWorld();
    const mod = localUser(w.people.moderator.id);
    const subject = { communityId: w.communities.open.id, targetActorId: w.people.reader.id };
    const ban = await banFromCommunity(await grantFor('mod.ban', mod, subject), { reason: 'Spam' });
    const unban = await unbanFromCommunity(await grantFor('mod.unban', mod, subject), { reason: 'Served' });
    const siteLog = await seedModlog(w.people.admin, w.people.reader);
    await emitEvent({
      type: 'mod.ban',
      v: 1,
      modlogId: siteLog.id,
      moderatorId: w.people.admin.id,
      local: true,
      targetActorId: w.people.reader.id,
      targetApId: w.people.reader.apId,
      communityId: null,
      banned: true,
      removeContent: false,
      expiresAt: null,
      reason: 'Spam',
    });
    await drainNotices();

    const rows = await noticesOf(w.people.reader.id);
    expect(rows.map((row) => [row.kind, row.refId, row.communityId, row.actorId])).toEqual([
      ['ban', ban.modlogId, w.communities.open.id, w.people.moderator.id],
      ['unban', unban.modlogId, w.communities.open.id, w.people.moderator.id],
      ['ban', siteLog.id, null, w.people.admin.id],
    ]);
  });

  test('banning a remote person tells nobody', async () => {
    const w = await seedInboxWorld();
    const subject = { communityId: w.communities.open.id, targetActorId: w.people.remoteAuthor.id };
    await banFromCommunity(await grantFor('mod.ban', localUser(w.people.moderator.id), subject), {});
    await drainNotices();
    expect(await noticeCount()).toBe(0);
  });
});

describe('account deletion', () => {
  test('purges only the deleted person’s notices', async () => {
    const w = await seedInboxWorld();
    await seedNotice({ recipientId: w.people.reader.id, kind: 'reply', refId: uuidv7() });
    await seedNotice({ recipientId: w.people.reader.id, kind: 'mention', refId: uuidv7() });
    await seedNotice({ recipientId: w.people.author.id, kind: 'reply', refId: uuidv7() });
    await emitEvent({ type: 'actor.deleted', v: 1, actorId: w.people.reader.id, kind: 'Person', local: true });
    await emitEvent({ type: 'actor.deleted', v: 1, actorId: w.people.remoteAuthor.id, kind: 'Person', local: false });
    await drainNotices();
    expect(await noticesOf(w.people.reader.id)).toEqual([]);
    expect(await noticesOf(w.people.author.id)).toHaveLength(1);
  });
});

describe('blocks', () => {
  test('a blocked author’s reply and mention create nothing, whether the person, their instance or the community is blocked', async () => {
    const w = await seedInboxWorld();
    const me = w.people.author;
    const postId = w.posts.local.normal;
    const mentionIn = (await seedPost(w.instances.local, w.communities.open, w.people.owner)).id;

    // The person.
    await seedBlock(me, w.people.reader);
    await say(w.people.reader, postId, 'A reply');
    await say(w.people.reader, mentionIn, 'Hello @author@feddit.test');
    await drainNotices();
    expect(await kindsOf(me.id)).toEqual([]);

    // Their instance: a peer's reply.
    await seedBlock(me, { instance: w.instances.lemmy });
    await remoteSay(w.people.remoteAuthor, await postApId(postId));
    await drainNotices();
    expect(await kindsOf(me.id)).toEqual([]);

    // The community: a person who is not blocked, replying in it.
    await seedBlock(me, w.communities.open);
    await say(w.people.moderator, postId, 'From a moderator');
    await drainNotices();
    expect(await kindsOf(me.id)).toEqual([]);
  });

  test('someone else’s block changes nothing for this recipient', async () => {
    const w = await seedInboxWorld();
    await seedBlock(w.people.owner, w.people.reader);
    await say(w.people.reader, w.posts.local.normal, 'A reply');
    await drainNotices();
    expect(await kindsOf(w.people.author.id)).toEqual(['reply']);
  });

  test('a blocked moderator’s removal and ban still notify: the statement of reasons is owed', async () => {
    const w = await seedInboxWorld();
    const mod = localUser(w.people.moderator.id);
    await seedBlock(w.people.reader, w.people.moderator);
    await seedBlock(w.people.reader, w.communities.open);
    const id = await say(w.people.reader, w.posts.local.normal, 'Rude');
    await removeContent(await grantFor('mod.remove', mod, { target: { kind: 'comment', id } }), { reason: 'Rule 2' });
    await banFromCommunity(await grantFor('mod.ban', mod, { communityId: w.communities.open.id, targetActorId: w.people.reader.id }), {});
    await drainNotices();
    expect(await kindsOf(w.people.reader.id)).toEqual(['mod_remove', 'ban']);
  });
});
