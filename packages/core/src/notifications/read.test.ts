import { writeFileSync } from 'node:fs';
import { and, desc, eq, isNotNull, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeEach, describe, expect, test } from 'vitest';
import { db, type Queryable } from '../db/read.ts';
import { writer } from '../db/write.ts';
import { personalNoticeKinds } from '../identity/personal.ts';
import { peerControls } from '../peers/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedComment, seedPost } from '../testing/seed-az.ts';
import { declareAge } from '../testing/seed-b1.ts';
import { seedBlock } from '../testing/seed-e1.ts';
import { noticesOf, seedInboxWorld, seedModlog, seedNotice } from '../testing/seed-e2.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { inboxPageSize, readInbox } from './read.ts';
import { markAllNotificationsReadAs, undoMarkAllReadAs } from './service.ts';
import { notifications } from './tables.ts';
import { unreadCount, unreadCountQuery } from './unread.ts';
import { filterKinds, notificationKinds, unreadCap, type InboxFilter } from './view.ts';
import { inboxVisible } from './visible.ts';

beforeEach(truncateAll);

const viewerOf = (person: { id: string }) => ({ actorId: person.id, siteRole: 'user' as const });

describe('readInbox filters', () => {
  test('each filter lists exactly its kinds, newest first, and Unread only the unread ones', async () => {
    const w = await seedInboxWorld();
    const me = w.people.author;
    const read = new Date();
    // A followed thread's notice is listed only with a comment the viewer may read.
    const comment = await seedComment(w.instances.local, { id: w.posts.local.normal }, w.people.reader);
    const about = (kind: (typeof notificationKinds)[number]) =>
      kind === 'thread_reply' ? { commentId: comment.id, postId: w.posts.local.normal } : {};
    // One read and one unread notice of every kind, oldest first.
    for (const kind of notificationKinds) {
      await seedNotice({ recipientId: me.id, kind, refId: uuidv7(), readAt: read, ...about(kind) });
      await seedNotice({ recipientId: me.id, kind, refId: uuidv7(), ...about(kind) });
    }
    await seedNotice({ recipientId: w.people.reader.id, kind: 'reply', refId: uuidv7() });

    const kindsOf = async (filter: InboxFilter) => (await readInbox(viewerOf(me), { filter })).items.map((item) => item.kind);
    const everything = await readInbox(viewerOf(me), { filter: 'all' });
    expect(everything.items).toHaveLength(2 * notificationKinds.length);
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
    expect(unread.items).toHaveLength(notificationKinds.length);
    expect(unread.items.every((item) => !item.read)).toBe(true);
    expect(everything.unread).toBe(notificationKinds.length);
    // thread_reply counts with the replies, follow_accept with the account notices.
    expect(everything.unreadByGroup).toEqual({ replies: 2, mentions: 1, content: 2, account: 3 });
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
      actorWithheld: null,
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

  test('sensitive content shows no text for anyone, a removed or deleted comment shows that word, a removed or deleted post no title', async () => {
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
    // A reply under a post deleted since, and a removal of a post with the moderator's statement.
    const deletedPost = await seedPost(w.instances.local, w.communities.open, me, { title: 'Deleted title', deletedAt: new Date() });
    await notice(await seedComment(w.instances.local, deletedPost, w.people.reader, { bodyMd: 'Under a deleted post' }));
    const entry = await seedModlog(w.people.moderator, me, {
      action: 'mod.remove',
      communityId: w.communities.open.id,
      communityApId: w.communities.open.apId,
      targetPostId: removedPost.id,
      targetApId: removedPost.apId,
      reason: 'Rule 3',
      authority: { kind: 'local-role', actorId: w.people.moderator.id, role: 'moderator', communityId: w.communities.open.id },
    });
    await seedNotice({ recipientId: me.id, kind: 'mod_remove', refId: entry.id, modlogId: entry.id, postId: removedPost.id });

    const items = (await readInbox(viewerOf(me))).items.toReversed();
    expect(items.map((item) => [item.withheld, item.excerpt, item.postTitle])).toEqual([
      [null, 'Visible words', 'Plain'],
      // A removed or deleted reply names no one, and so no title either (actorWithheld).
      ['removed', null, null],
      ['deleted', null, null],
      ['sensitive', null, null],
      ['sensitive', null, null],
      ['sensitive', null, null],
      ['sensitive', null, null],
      ['removed', null, null],
      ['deleted', null, null],
      ['removed', null, null],
    ]);
    expect(items.at(-1)?.statement).toMatchObject({ modlogId: entry.id, reason: 'Rule 3' });
  });

  test('a reply or mention names its author only where the thread would: not for a deleted comment, a removed or deleted post, nor gated content to the undeclared', async () => {
    const w = await seedInboxWorld();
    const { author: me, reader: replier, moderator } = w.people;
    // `moderator` declared 16+ at sign-up; `me` is the imported kind that has no declaration.
    await declareAge(moderator);
    const plain = await seedPost(w.instances.local, w.communities.open, me, { title: 'Plain' });
    const sensitive = await seedPost(w.instances.local, w.communities.open, me, { title: 'Secret', sensitive: true });
    const gone = await seedPost(w.instances.local, w.communities.open, me, { title: 'Gone', deletedAt: new Date() });
    const takenDown = await seedPost(w.instances.local, w.communities.open, me, { title: 'Taken down', removedAt: new Date() });
    const reply = async (recipient: { id: string }, post: { id: string }, extra: Parameters<typeof seedComment>[3] = {}) => {
      const comment = await seedComment(w.instances.local, post, replier, { bodyMd: 'Words', ...extra });
      const notice = await seedNotice({
        recipientId: recipient.id,
        kind: 'reply',
        refId: comment.id,
        actorId: replier.id,
        communityId: w.communities.open.id,
        postId: post.id,
        commentId: comment.id,
      });
      return notice.id;
    };
    const ids = {
      live: await reply(me, plain),
      removed: await reply(me, plain, { removedAt: new Date() }),
      deleted: await reply(me, plain, { deletedAt: new Date() }),
      deletedAndRemoved: await reply(me, plain, { deletedAt: new Date(), removedAt: new Date() }),
      underDeletedPost: await reply(me, gone),
      underRemovedPost: await reply(me, takenDown),
      mentionInRemovedPost: (
        await seedNotice({ recipientId: me.id, kind: 'mention', refId: takenDown.id, actorId: moderator.id, postId: takenDown.id })
      ).id,
      mentionInDeletedPost: (
        await seedNotice({ recipientId: me.id, kind: 'mention', refId: gone.id, actorId: moderator.id, postId: gone.id })
      ).id,
      gated: await reply(me, sensitive),
      gatedDeclared: await reply(moderator, sensitive),
      // To a moderator of the community, who sees removed and deleted content's authors on the page.
      staffUnderRemovedPost: await reply(moderator, takenDown),
      staffDeleted: await reply(moderator, plain, { deletedAt: new Date() }),
      staffRemoved: await reply(moderator, plain, { removedAt: new Date() }),
      staffMentionInRemovedPost: (
        await seedNotice({ recipientId: moderator.id, kind: 'mention', refId: takenDown.id, actorId: replier.id, postId: takenDown.id })
      ).id,
      mention: (await seedNotice({ recipientId: me.id, kind: 'mention', refId: sensitive.id, actorId: moderator.id, postId: sensitive.id }))
        .id,
      // A moderator's notice names the moderator, whatever the content.
      removal: (await seedNotice({ recipientId: me.id, kind: 'mod_remove', refId: uuidv7(), actorId: moderator.id, postId: sensitive.id }))
        .id,
    };
    const items = new Map(
      [...(await readInbox(viewerOf(me))).items, ...(await readInbox(viewerOf(moderator))).items].map((item) => [item.id, item]),
    );
    const named = (id: string) => [items.get(id)?.actor?.id ?? null, items.get(id)?.actorWithheld ?? null, items.get(id)?.withheld];
    // As the thread shows them: a live comment with its author, and one under a deleted post too.
    expect(named(ids.live)).toEqual([replier.id, null, null]);
    expect(named(ids.underDeletedPost)).toEqual([replier.id, null, 'deleted']);
    // A removed comment is a tombstone without its author, as a deleted one is.
    expect(named(ids.removed)).toEqual([null, 'removed', 'removed']);
    // Under a post a moderator removed the page sends no comments, and a removed or deleted post names no author.
    expect(named(ids.underRemovedPost)).toEqual([null, 'removed', 'removed']);
    expect(named(ids.mentionInRemovedPost)).toEqual([null, 'removed', 'removed']);
    expect(named(ids.mentionInDeletedPost)).toEqual([null, 'deleted', 'deleted']);
    // A deleted comment is a tombstone without its author, removed as well or not.
    expect(named(ids.deleted)).toEqual([null, 'deleted', 'deleted']);
    expect(named(ids.deletedAndRemoved)).toEqual([null, 'deleted', 'deleted']);
    // Gated: the post page shows an undeclared viewer nothing of the post; a declared one passes Hide NSFW on the page.
    expect(named(ids.gated)).toEqual([null, 'sensitive', 'sensitive']);
    expect(named(ids.mention)).toEqual([null, 'sensitive', 'sensitive']);
    expect(named(ids.gatedDeclared)).toEqual([replier.id, null, 'sensitive']);
    expect(named(ids.removal)).toEqual([moderator.id, null, 'sensitive']);
    // The community's staff are told, as its pages tell them.
    expect(named(ids.staffUnderRemovedPost)).toEqual([replier.id, null, 'removed']);
    expect(named(ids.staffDeleted)).toEqual([replier.id, null, 'deleted']);
    expect(named(ids.staffRemoved)).toEqual([replier.id, null, 'removed']);
    expect(named(ids.staffMentionInRemovedPost)).toEqual([replier.id, null, 'removed']);
    expect(items.get(ids.staffMentionInRemovedPost)?.postId).toBe(takenDown.id);
    // Nothing else of the person rides along: no id, name, handle or address, and no comment id to
    // look the comment up by. What is left links to the thread (the post) and marks the notice read.
    const withheld = [
      ids.deleted,
      ids.deletedAndRemoved,
      ids.removed,
      ids.underRemovedPost,
      ids.mentionInRemovedPost,
      ids.mentionInDeletedPost,
    ];
    for (const id of [...withheld, ids.gated, ids.mention]) {
      const item = items.get(id)!;
      const text = JSON.stringify(item);
      for (const leak of [replier.id, moderator.id, replier.name, moderator.name, replier.apId, moderator.apId])
        expect([id, text.includes(leak)]).toEqual([id, false]);
      // No comment id and no post id: the post leads to its title and its author (the modlog, the
      // object route) as surely as a name. The row links to the community instead.
      expect([id, item.commentId, item.postId]).toEqual([id, null, null]);
      // Nor the title of the post it answers: a title can name its author.
      expect([id, item.postTitle]).toEqual([id, null]);
    }
    expect(items.get(ids.live)?.commentId).not.toBeNull();
    expect(items.get(ids.live)?.postTitle).toBe('Plain');
    // A blocked author's reply is not listed at all (inboxVisible), which says less than a tombstone.
    await seedBlock(me, replier);
    expect((await readInbox(viewerOf(me))).items.map((item) => item.id)).not.toContain(ids.live);
  });

  test('behind the age gate a reply or mention reads the same whatever became of its comment or post', async () => {
    const w = await seedInboxWorld();
    const { local } = w.instances;
    const { open } = w.communities;
    // `moderator` and `owner` moderate `open`; no one here has declared 16+ but those told to.
    const readers = { member: w.people.author, declaredMember: w.people.reader, staff: w.people.moderator, declaredStaff: w.people.owner };
    await declareAge(readers.declaredMember);
    await declareAge(readers.declaredStaff);
    const replier = await seedActor(local, 'Person', 'replier');
    const at = new Date();
    // Each case is its own sensitive post: a reply to a comment in it, or a mention in the post itself.
    const cases: {
      kind: 'reply' | 'mention';
      state: string;
      post?: Parameters<typeof seedPost>[3];
      comment?: Parameters<typeof seedComment>[3];
    }[] = [
      { kind: 'reply', state: 'live', comment: {} },
      { kind: 'reply', state: 'removed', comment: { removedAt: at } },
      { kind: 'reply', state: 'deleted', comment: { deletedAt: at } },
      { kind: 'reply', state: 'removed and deleted', comment: { removedAt: at, deletedAt: at } },
      { kind: 'reply', state: 'post removed', post: { removedAt: at }, comment: {} },
      { kind: 'mention', state: 'live' },
      { kind: 'mention', state: 'post removed', post: { removedAt: at } },
      { kind: 'mention', state: 'post deleted', post: { deletedAt: at } },
    ];
    /** Each case's row as the reader's inbox sends it, but for the notice's own id and time. */
    const rowsOf = async (reader: { id: string }) => {
      const ids: string[] = [];
      for (const { kind, post: postExtra, comment: commentExtra } of cases) {
        const post = await seedPost(local, open, replier, { title: 'Secret', sensitive: true, ...postExtra });
        const comment = commentExtra && (await seedComment(local, post, replier, { bodyMd: 'Words', ...commentExtra }));
        const notice = await seedNotice({
          recipientId: reader.id,
          kind,
          refId: comment ? comment.id : post.id,
          actorId: replier.id,
          communityId: open.id,
          postId: post.id,
          commentId: comment ? comment.id : null,
        });
        ids.push(notice.id);
      }
      const items = new Map((await readInbox(viewerOf(reader))).items.map((item) => [item.id, item]));
      return cases.map(({ kind, state }, n) => {
        const { id: _id, createdAt: _createdAt, ...row } = items.get(ids[n]!)!;
        return { kind, state, row };
      });
    };

    // Not declared 16+, staff or not: the post page shows them nothing of the post, so the row says
    // only that it is sensitive, the same serialised row for every state of the content.
    for (const reader of ['member', 'staff'] as const) {
      const rows = await rowsOf(readers[reader]);
      for (const kind of ['reply', 'mention'] as const) {
        const states = Object.fromEntries(rows.filter((row) => row.kind === kind).map(({ state, row }) => [state, JSON.stringify(row)]));
        const asLive = Object.fromEntries(Object.keys(states).map((state) => [state, states.live]));
        expect([reader, kind, states]).toEqual([reader, kind, asLive]);
      }
      expect(rows[0]?.row).toMatchObject({
        actor: null,
        actorWithheld: 'sensitive',
        withheld: 'sensitive',
        postId: null,
        commentId: null,
        postTitle: null,
        excerpt: null,
      });
    }

    // Declared: a member is told the reasons the thread gives, staff are named the author throughout.
    const named = async (reader: { id: string }) =>
      Object.fromEntries(
        (await rowsOf(reader)).map(({ kind, state, row }) => [
          `${kind} ${state}`,
          [row.actor?.id ?? null, row.actorWithheld, row.withheld],
        ]),
      );
    expect(await named(readers.declaredMember)).toEqual({
      'reply live': [replier.id, null, 'sensitive'],
      'reply removed': [null, 'removed', 'sensitive'],
      'reply deleted': [null, 'deleted', 'sensitive'],
      'reply removed and deleted': [null, 'deleted', 'sensitive'],
      'reply post removed': [null, 'removed', 'sensitive'],
      'mention live': [replier.id, null, 'sensitive'],
      'mention post removed': [null, 'removed', 'sensitive'],
      'mention post deleted': [null, 'deleted', 'sensitive'],
    });
    expect(await named(readers.declaredStaff)).toEqual(
      Object.fromEntries(cases.map(({ kind, state }) => [`${kind} ${state}`, [replier.id, null, 'sensitive']])),
    );
  });

  test('a reply or mention whose comment or post is gone from the database names no one and quotes nothing', async () => {
    const w = await seedInboxWorld();
    const { author: me, reader: replier } = w.people;
    const post = await seedPost(w.instances.local, w.communities.open, me, { title: 'Still here', bodyMd: 'The surviving post' });
    const mentioning = await seedPost(w.instances.local, w.communities.open, replier, { title: 'Soon gone', bodyMd: 'Hi @author' });
    const comment = await seedComment(w.instances.local, post, replier, { bodyMd: 'Words' });
    const base = { recipientId: me.id, actorId: replier.id, communityId: w.communities.open.id };
    const reply = await seedNotice({ ...base, kind: 'reply', refId: comment.id, postId: post.id, commentId: comment.id });
    const mention = await seedNotice({ ...base, kind: 'mention', refId: mentioning.id, postId: mentioning.id });
    // Purged: the notices' links go null, their ref ids stay.
    await writer().execute(sql`delete from comments where id = ${comment.id}::uuid`);
    await writer().execute(sql`delete from posts where id = ${mentioning.id}::uuid`);
    const items = new Map((await readInbox(viewerOf(me))).items.map((item) => [item.id, item]));
    for (const id of [reply.id, mention.id]) {
      const item = items.get(id)!;
      expect([id, item.actor, item.actorWithheld, item.excerpt, item.postTitle, item.postId]).toEqual([
        id,
        null,
        'deleted',
        null,
        null,
        null,
      ]);
      const text = JSON.stringify(item);
      for (const leak of [replier.id, replier.name, replier.apId, 'The surviving post', 'Still here'])
        expect([id, leak, text.includes(leak)]).toEqual([id, leak, false]);
    }
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

describe('one visibility rule for the list and every count', () => {
  test('an unread notice in a deleted or removed community is neither listed nor counted', async () => {
    const w = await seedInboxWorld();
    const me = w.people.author;
    const gone = await seedActor(w.instances.local, 'Group', 'gone', { deletedAt: new Date() });
    for (const community of [w.communities.open, w.communities.removed, gone]) {
      await seedNotice({ recipientId: me.id, kind: 'mod_remove', refId: uuidv7(), communityId: community.id });
      await seedNotice({ recipientId: me.id, kind: 'reply', refId: uuidv7(), communityId: community.id });
    }
    const inbox = await readInbox(viewerOf(me));
    expect(inbox.items.map((item) => item.community?.name)).toEqual(['open', 'open']);
    expect(inbox.unread).toBe(2);
    expect(inbox.unreadByGroup).toEqual({ replies: 1, mentions: 0, content: 1, account: 0 });
    // The sidebar badge (shell/data.ts) reads unreadCount.
    expect(await unreadCount(me.id)).toBe(2);
    expect((await readInbox(viewerOf(me), { filter: 'unread' })).items).toHaveLength(2);
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

/** One node of an executed plan (EXPLAIN (ANALYZE, FORMAT JSON)), as far as rowsVisited reads it. */
type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: PlanNode[];
};

/** The rows each table's scans read in a plan, kept or filtered out, over all their loops (a written table's own node aside). */
function rowsVisited(node: PlanNode, visited: Record<string, number> = {}): Record<string, number> {
  const table = node['Relation Name'];
  if (table && node['Node Type'] !== 'ModifyTable') {
    const perLoop = (node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0);
    visited[table] = (visited[table] ?? 0) + Math.round(perLoop * (node['Actual Loops'] ?? 0));
  }
  for (const child of node.Plans ?? []) rowsVisited(child, visited);
  return visited;
}

/** Runs `statement` for real under EXPLAIN ANALYZE: the rows it answered (or wrote) and the rows it visited. */
async function executed(q: Queryable, statement: { getSQL(): SQL }) {
  const [row] = await q.execute<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(sql`explain (analyze, buffers, format json) ${statement.getSQL()}`);
  const plan = row!['QUERY PLAN'][0]!.Plan;
  return { rows: plan['Actual Rows'] ?? 0, visited: rowsVisited(plan), plan };
}

// Mark all read's and its Undo's statements, as mutations.ts writes them.
const readStamp = sql<string>`(extract(epoch from ${notifications.readAt}) * 1000000)::bigint::text`;
const markStatement = (q: Queryable, me: string) =>
  q
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notifications.recipientId, me),
        isNull(notifications.readAt),
        or(notInArray(notifications.kind, [...personalNoticeKinds]), inboxVisible(me)),
      ),
    )
    .returning({ id: notifications.id, batch: readStamp, shown: inboxVisible(me) });
const undoStatement = (q: Queryable, me: string, batch: string) =>
  q
    .update(notifications)
    .set({ readAt: null })
    .where(and(eq(notifications.recipientId, me), isNotNull(notifications.readAt), sql`${readStamp} = ${batch}`))
    .returning({ id: notifications.id, shown: inboxVisible(me) });

class RolledBack extends Error {}

/**
 * The inbox's statements for `me`, each executed: the unread count, the four filter counts and a
 * page of the list; then Mark all read and the Undo of the batch it wrote, in one transaction
 * rolled back after.
 */
async function executedInbox(me: string) {
  const measured: Record<string, Awaited<ReturnType<typeof executed>>> = { count: await executed(db(), unreadCountQuery(db(), me)) };
  for (const group of ['replies', 'mentions', 'content', 'account'] as const) {
    measured[group] = await executed(db(), unreadCountQuery(db(), me, filterKinds[group]));
  }
  const page = db().select({ notice: notifications }).from(notifications).where(inboxVisible(me)).orderBy(desc(notifications.id));
  measured.list = await executed(db(), page.limit(inboxPageSize + 1));
  await writer()
    .transaction(async (t) => {
      measured.mark = await executed(t, markStatement(t, me));
      const [stamp] = await t.execute<{ batch: string }>(sql`select (extract(epoch from now()) * 1000000)::bigint::text as batch`);
      measured.undo = await executed(t, undoStatement(t, me, stamp!.batch));
      throw new RolledBack();
    })
    .catch((error: unknown) => {
      if (!(error instanceof RolledBack)) throw error;
    });
  return measured;
}

describe('the inbox reads only the rows its notices name', () => {
  // A world where a pass over any table is unmistakable: 10,000 peers, each with its peer_controls
  // row, a person, a community and a post; 5,000 more people on each of two peers (one this server
  // comes to block, one the viewer does); 5,000 removed communities; 20,000 comments and 40,000
  // notices of other people. The viewer holds 400 notices, enough for the planner to weigh a pass
  // over a table against a lookup per notice; half unread: old kinds naming a person and a
  // community, followed-thread notices and follows' answers. Every statement that applies
  // inboxVisible runs for real, with nothing blocked, with a blocked peer, and with the viewer's
  // own blocks too: none may read more of notifications than the viewer's own, nor more than five
  // rows of any other table for each of them (2,000, where a pass over the smallest reads 5,000).
  // The unread count runs on every signed-in page load. INBOX_PLANS=<file> writes each
  // statement's plan and the rows it visited there.
  test('the counts, the list, Mark all read and its Undo read a few rows per notice, blocked or not', { timeout: 180_000 }, async () => {
    const w = await seedInboxWorld();
    const me = w.people.author.id;
    const mine = 400;
    const perNotice = 5;
    // Ids by number, so rows can name each other: person, post and comment n live on peer 1 + (n - 1) % 10,000.
    const id = (prefix: string) => (n: string) => `('${prefix}-0000-4000-8000-' || lpad((${n})::text, 12, '0'))::uuid`;
    const [peer, person, group, post, comment] = ['a0000001', 'a0000002', 'a0000003', 'a0000004', 'a0000005'].map(id) as [
      ReturnType<typeof id>,
      ReturnType<typeof id>,
      ReturnType<typeof id>,
      ReturnType<typeof id>,
      ReturnType<typeof id>,
    ];
    const on = (n: string) => `(1 + ((${n}) - 1) % 10000)`;
    const oldKinds = `(array['reply','mention','mod_remove','mod_restore','ban','unban'])`;
    const viewer = `'${me}'::uuid`;
    const run = (statement: string) => writer().execute(sql.raw(statement));
    await run(`insert into instances (id, domain, origin)
      select ${peer('n')}, 'peer' || n || '.test', 'https://peer' || n || '.test' from generate_series(1, 10000) n`);
    await run(`insert into peer_controls (instance_id) select ${peer('n')} from generate_series(1, 10000) n`);
    await run(`insert into actors (id, ap_id, kind, local, instance_id, name)
      select ${person('n')}, 'https://peer.test/u/' || n, 'Person', false,
        ${peer(`case when n <= 10000 then n when n <= 15000 then 500 else 1000 end`)}, 'p' || n
      from generate_series(1, 20000) n`);
    await run(`insert into actors (id, ap_id, kind, local, instance_id, name)
      select ${group('n')}, 'https://peer.test/c/' || n, 'Group', false, ${peer('n')}, 'c' || n from generate_series(1, 10000) n`);
    await run(`insert into community_removals (community_id) select ${group('n')} from generate_series(5001, 10000) n`);
    await run(`insert into posts (id, ap_id, local, instance_id, author_id, community_id, title, published_at)
      select ${post('n')}, 'https://peer.test/post/' || n, false, ${peer('n')}, ${person('n')}, ${group('n')}, 'Post ' || n, now()
      from generate_series(1, 10000) n`);
    await run(`insert into comments (id, ap_id, local, instance_id, post_id, author_id, path, body_md, published_at)
      select ${comment('m')}, 'https://peer.test/comment/' || m, false, ${peer(on('m'))}, ${post(on('m'))}, ${person(on('m'))},
        replace(${comment('m')}::text, '-', '_')::ltree, 'A comment', now()
      from generate_series(1, 20000) m`);
    await run(`insert into notifications (id, recipient_id, kind, ref_id, actor_id, community_id, read_at)
      select gen_random_uuid(), ${person('1 + n % 10000')}, ${oldKinds}[1 + n % 6], gen_random_uuid(), ${person('1 + (n * 7) % 10000')},
        ${group(on('n'))}, case when n % 23 = 0 then null else now() end
      from generate_series(1, 20000) n`);
    await run(`insert into notifications (id, recipient_id, kind, ref_id, actor_id, community_id, post_id, comment_id, read_at)
      select gen_random_uuid(), ${person('1 + (m * 3) % 10000')}, 'thread_reply', ${comment('m')}, ${person(on('m'))}, ${group(on('m'))},
        ${post(on('m'))}, ${comment('m')}, case when m % 23 = 0 then null else now() end
      from generate_series(1, 20000) m`);
    // The viewer's: 160 of the old kinds from people on peers 1 to 160, in communities across the
    // peers (the last 60 removed); 160 followed-thread notices on peers 125, 250 and so on, two on
    // each; 80 follows' answers from those peers' communities. The odd ones are unread.
    const unreadWhenOdd = `case when k % 2 = 1 then null else now() end`;
    await run(`insert into notifications (id, recipient_id, kind, ref_id, actor_id, community_id, read_at)
      select gen_random_uuid(), ${viewer}, ${oldKinds}[1 + k % 6], gen_random_uuid(), ${person('k')}, ${group('k * 50')}, ${unreadWhenOdd}
      from generate_series(1, 160) k`);
    await run(`insert into notifications (id, recipient_id, kind, ref_id, actor_id, community_id, post_id, comment_id, read_at)
      select gen_random_uuid(), ${viewer}, 'thread_reply', ${comment('k * 125')}, ${person(on('k * 125'))}, ${group(on('k * 125'))},
        ${post(on('k * 125'))}, ${comment('k * 125')}, ${unreadWhenOdd}
      from generate_series(1, 160) k`);
    await run(`insert into notifications (id, recipient_id, kind, ref_id, community_id, read_at)
      select gen_random_uuid(), ${viewer}, 'follow_accept', gen_random_uuid(), ${group('k * 125')}, ${unreadWhenOdd}
      from generate_series(1, 80) k`);
    const analyse = () =>
      run(`analyze instances, peer_controls, actors, community_removals, posts, comments, notifications,
        person_blocks, community_blocks, instance_blocks`);

    const phases: Record<string, Awaited<ReturnType<typeof executedInbox>>> = {};
    await analyse();
    phases['nothing blocked'] = await executedInbox(me);
    // Peer 500 holds 5,000 more people, two of the viewer's followed-thread notices and a follow's answer.
    await run(`update peer_controls set blocked = true where instance_id = ${peer('500')}`);
    await analyse();
    phases['a blocked peer'] = await executedInbox(me);
    // Peer 1,000 holds the other 5,000; the viewer blocks it, a person and a community as well.
    await run(`insert into instance_blocks (blocker_id, instance_id) values (${viewer}, ${peer('1000')})`);
    await run(`insert into person_blocks (blocker_id, blocked_id) values (${viewer}, ${person('3')})`);
    await run(`insert into community_blocks (blocker_id, community_id) values (${viewer}, ${group('1500')})`);
    await analyse();
    phases['a blocked peer and the viewer’s blocks'] = await executedInbox(me);
    if (process.env.INBOX_PLANS) writeFileSync(process.env.INBOX_PLANS, JSON.stringify(phases, null, 2));

    for (const [phase, statements] of Object.entries(phases)) {
      for (const [name, { visited }] of Object.entries(statements)) {
        const { notifications: notices = 0, ...others } = visited;
        expect.soft(notices, `${phase}, ${name}: notifications`).toBeLessThanOrEqual(mine);
        for (const [table, rows] of Object.entries(others)) {
          expect.soft(rows, `${phase}, ${name}: ${table}`).toBeLessThanOrEqual(perNotice * mine);
        }
      }
      // And they answer: a page is listed, Mark all read marks, and its Undo finds every row it marked.
      expect(statements.list!.rows, phase).toBeGreaterThan(0);
      expect(statements.mark!.rows, phase).toBeGreaterThan(0);
      expect(statements.undo!.rows, phase).toBe(statements.mark!.rows);
    }
  });
});

/**
 * One world with every case inboxVisible decides, on three servers: this one (L), a peer this
 * server blocks (P) and one the first viewer blocks (V). Each case is written as a notice to both
 * viewers, once unread and once read: `blocking` declared 16+ and blocking V, the person `pest`
 * and the community `muted`; `undeclared` blocking nothing. `unblockPeer` lifts the block on P.
 */
async function seedEveryCase() {
  const w = await seedInboxWorld();
  const hosts = { L: w.instances.local, P: await seedInstance('blocked.test', false), V: await seedInstance('shunned.test', false) };
  await writer().insert(peerControls).values({ instanceId: hosts.P.id, blocked: true });
  const names = ['L', 'P', 'V'] as const;
  const people = {
    L: await seedActor(hosts.L, 'Person', 'l_person'),
    P: await seedActor(hosts.P, 'Person', 'p_person'),
    V: await seedActor(hosts.V, 'Person', 'v_person'),
  };
  const groups = {
    L: await seedActor(hosts.L, 'Group', 'l_group'),
    P: await seedActor(hosts.P, 'Group', 'p_group'),
    V: await seedActor(hosts.V, 'Group', 'v_group'),
  };
  const pest = await seedActor(hosts.L, 'Person', 'pest');
  const gone = await seedActor(hosts.L, 'Person', 'gone', { deletedAt: new Date() });
  const muted = await seedActor(hosts.L, 'Group', 'muted');
  const flagged = await seedActor(hosts.L, 'Group', 'flagged', { sensitive: true });
  const grim = await seedActor(hosts.L, 'Group', 'grim', { nsfl: true });
  const peerFlagged = await seedActor(hosts.P, 'Group', 'p_flagged', { sensitive: true });
  const deleted = await seedActor(hosts.L, 'Group', 'deleted', { deletedAt: new Date() });
  const removed = w.communities.removed;
  const viewers = { blocking: w.people.author, undeclared: w.people.owner };
  await declareAge(viewers.blocking);
  await seedBlock(viewers.blocking, { instance: hosts.V });
  await seedBlock(viewers.blocking, pest);
  await seedBlock(viewers.blocking, muted);

  type Row = Omit<typeof notifications.$inferInsert, 'recipientId' | 'refId'>;
  const cases: { label: string; row: Row }[] = [];
  const thread = (
    comment: { id: string },
    post: { id: string },
    community: { id: string } | null,
    commenter: { id: string } | null,
  ): Row => ({
    kind: 'thread_reply',
    actorId: commenter?.id ?? null,
    communityId: community?.id ?? null,
    postId: post.id,
    commentId: comment.id,
  });
  // A followed thread's comment for every server its commenter (a), post (b) and community (c) can live on.
  for (const c of names) {
    for (const b of names) {
      const post = await seedPost(hosts[b], groups[c], people[b]);
      for (const a of names)
        cases.push({ label: `thread ${a}${b}${c}`, row: thread(await seedComment(hosts[a], post, people[a]), post, groups[c], people[a]) });
    }
  }
  const plain = await seedPost(hosts.L, groups.L, people.L);
  const say = async (
    label: string,
    post: { id: string; communityId: string },
    commenter: { id: string } = people.L,
    extra: Parameters<typeof seedComment>[3] = {},
  ) => cases.push({ label, row: thread(await seedComment(hosts.L, post, commenter, extra), post, { id: post.communityId }, commenter) });
  const postIn = (community: { id: string }, extra: Parameters<typeof seedPost>[3] = {}, author: { id: string } = people.L) =>
    seedPost(hosts.L, community, author, extra);
  await say('thread comment removed', plain, people.L, { removedAt: new Date() });
  await say('thread comment deleted', plain, people.L, { deletedAt: new Date() });
  await say('thread commenter deleted', plain, gone);
  await say('thread commenter blocked', plain, pest);
  await say('thread post removed', await postIn(groups.L, { removedAt: new Date() }));
  await say('thread post deleted', await postIn(groups.L, { deletedAt: new Date() }));
  await say('thread post sensitive', await postIn(groups.L, { sensitive: true }));
  await say('thread post nsfl', await postIn(groups.L, { nsfl: true }));
  await say('thread post author blocked', await postIn(groups.L, {}, pest));
  await say('thread community sensitive', await postIn(flagged));
  await say('thread community nsfl', await postIn(grim));
  await say('thread community deleted', await postIn(deleted));
  await say('thread community removed', await postIn(removed));
  await say('thread community blocked', await postIn(muted));
  // The notice's own ids, apart from its comment's: purged, missing, or naming other rows.
  const live = await seedComment(hosts.L, plain, people.L);
  cases.push({ label: 'thread comment purged', row: { ...thread(live, plain, groups.L, people.L), commentId: null } });
  cases.push({ label: 'thread names nobody', row: thread(live, plain, null, null) });
  cases.push({ label: 'thread names V', row: thread(live, plain, groups.V, people.V) });
  cases.push({ label: 'thread names P', row: thread(live, plain, groups.P, people.P) });
  cases.push({ label: 'thread names deleted', row: thread(live, plain, deleted, people.L) });
  cases.push({ label: 'thread names removed', row: thread(live, plain, removed, people.L) });
  cases.push({ label: 'thread names blocked', row: thread(live, plain, muted, pest) });
  // A follow's answer, from each server's community and from every kind of community.
  for (const h of names) cases.push({ label: `accept ${h}`, row: { kind: 'follow_accept', communityId: groups[h].id } });
  for (const [label, community] of Object.entries({
    sensitive: flagged,
    nsfl: grim,
    'P sensitive': peerFlagged,
    deleted,
    removed,
    blocked: muted,
  })) {
    cases.push({ label: `accept ${label}`, row: { kind: 'follow_accept', communityId: community.id } });
  }
  cases.push({ label: 'accept no community', row: { kind: 'follow_accept' } });
  // The older kinds: a block hides a reply or a mention, never a removal or a ban; a deleted or removed community hides any.
  for (const h of names) {
    cases.push({ label: `reply from ${h}`, row: { kind: 'reply', actorId: people[h].id, communityId: groups.L.id } });
    cases.push({ label: `reply in ${h}`, row: { kind: 'reply', actorId: people.L.id, communityId: groups[h].id } });
    cases.push({ label: `ban from ${h}`, row: { kind: 'ban', actorId: people[h].id, communityId: groups[h].id } });
  }
  cases.push({ label: 'reply in blocked', row: { kind: 'reply', actorId: people.L.id, communityId: muted.id } });
  cases.push({ label: 'reply in deleted', row: { kind: 'reply', actorId: people.L.id, communityId: deleted.id } });
  cases.push({ label: 'reply in removed', row: { kind: 'reply', actorId: people.L.id, communityId: removed.id } });
  cases.push({ label: 'reply names nobody', row: { kind: 'reply' } });
  cases.push({ label: 'mention from blocked', row: { kind: 'mention', actorId: pest.id, communityId: groups.L.id } });
  cases.push({ label: 'mention from deleted', row: { kind: 'mention', actorId: gone.id, communityId: groups.L.id } });
  cases.push({ label: 'removal by blocked', row: { kind: 'mod_remove', actorId: pest.id, communityId: muted.id } });
  cases.push({ label: 'removal in deleted', row: { kind: 'mod_remove', actorId: people.L.id, communityId: deleted.id } });
  cases.push({ label: 'restore in V', row: { kind: 'mod_restore', actorId: people.V.id, communityId: groups.V.id } });
  cases.push({ label: 'unban from P', row: { kind: 'unban', actorId: people.P.id, communityId: groups.P.id } });

  const unblockPeer = () => writer().update(peerControls).set({ blocked: false }).where(eq(peerControls.instanceId, hosts.P.id));
  return { viewers, cases, unblockPeer };
}

describe('which notices the inbox shows, case by case', () => {
  // Which cases each viewer is shown, while P is blocked and once it is not, what the counts say,
  // and what Mark all read and its Undo answer, were read once from the rule as it stood at
  // c44f8c0c and are written out in `atBase`: a rule that reads fewer rows must answer the same.
  test(
    'the list, the counts, Mark all read and Undo answer as they did, and unblocking a peer gives its notices back',
    { timeout: 60_000 },
    async () => {
      const { viewers, cases, unblockPeer } = await seedEveryCase();
      const labelOf = new Map<string, string>();
      const readEarlier = new Date(Date.now() - 60_000);
      for (const viewer of Object.values(viewers)) {
        for (const { label, row } of cases) {
          for (const readAt of [null, readEarlier])
            labelOf.set((await seedNotice({ ...row, recipientId: viewer.id, refId: uuidv7(), readAt })).id, label);
        }
      }
      const personal = new Set(
        cases.filter(({ row }) => row.kind === 'thread_reply' || row.kind === 'follow_accept').map(({ label }) => label),
      );
      const unreadOf = async (viewer: { id: string }) => (await noticesOf(viewer.id)).filter((notice) => notice.readAt === null);
      /** The cases the viewer is not shown; a case is hidden read and unread alike. */
      const hiddenFrom = async (viewer: { id: string }) => {
        const inbox = await readInbox(viewerOf(viewer), { limit: 500 });
        const ids = inbox.items.map((item) => item.id);
        expect(ids).toEqual(ids.toSorted().toReversed());
        const listed = new Set(ids);
        const hidden = (await noticesOf(viewer.id)).filter((notice) => !listed.has(notice.id));
        const cases = new Set(hidden.map((notice) => labelOf.get(notice.id)!));
        expect(hidden).toHaveLength(2 * cases.size);
        return { inbox, cases };
      };
      /** What the viewer is not shown, the counts, and what Mark all read and its Undo answer. */
      const outcomeOf = async (viewer: { id: string }) => {
        const { inbox, cases } = await hiddenFrom(viewer);
        const unread = (await unreadOf(viewer)).map((notice) => notice.id);
        const marked = await markAllNotificationsReadAs(localUser(viewer.id));
        if (!marked.ok) throw new Error(marked.reason);
        // Mark all read leaves unread exactly the hidden notices of the personal kinds.
        const leftUnread = new Set((await unreadOf(viewer)).map((notice) => labelOf.get(notice.id)!));
        expect(leftUnread).toEqual(new Set([...cases].filter((label) => personal.has(label))));
        const undone = await undoMarkAllReadAs(localUser(viewer.id), marked.batch ?? '');
        if (!undone.ok) throw new Error(undone.reason);
        // Its Undo gives back exactly what it took.
        expect((await unreadOf(viewer)).map((notice) => notice.id)).toEqual(unread);
        return {
          hidden: cases,
          counts: { unread: inbox.unread, byGroup: inbox.unreadByGroup, marked: marked.count, undone: undone.count },
        };
      };

      const blocking = await outcomeOf(viewers.blocking);
      const undeclared = await outcomeOf(viewers.undeclared);
      await unblockPeer();
      const unblocked = [(await hiddenFrom(viewers.blocking)).cases, (await hiddenFrom(viewers.undeclared)).cases];
      const hidden = [blocking.hidden, undeclared.hidden, ...unblocked];
      const shown = Object.fromEntries(cases.map(({ label }) => [label, hidden.map((cases) => (cases.has(label) ? 'x' : '-')).join('')]));
      expect(shown).toEqual(atBase.shown);
      expect({ blocking: blocking.counts, undeclared: undeclared.counts }).toEqual(atBase.counts);
    },
  );
});

/**
 * What the rule answered at c44f8c0c. `shown` has one line per case: x where it is hidden, - where
 * it is shown, for the first viewer and the second while P is blocked, then for both once it is not.
 */
const atBase = {
  shown: {
    'thread LLL': '----',
    'thread PLL': 'xx--',
    'thread VLL': 'x-x-',
    'thread LPL': 'xx--',
    'thread PPL': 'xx--',
    'thread VPL': 'xxx-',
    'thread LVL': 'x-x-',
    'thread PVL': 'xxx-',
    'thread VVL': 'x-x-',
    'thread LLP': 'xx--',
    'thread PLP': 'xx--',
    'thread VLP': 'xxx-',
    'thread LPP': 'xx--',
    'thread PPP': 'xx--',
    'thread VPP': 'xxx-',
    'thread LVP': 'xxx-',
    'thread PVP': 'xxx-',
    'thread VVP': 'xxx-',
    'thread LLV': 'x-x-',
    'thread PLV': 'xxx-',
    'thread VLV': 'x-x-',
    'thread LPV': 'xxx-',
    'thread PPV': 'xxx-',
    'thread VPV': 'xxx-',
    'thread LVV': 'x-x-',
    'thread PVV': 'xxx-',
    'thread VVV': 'x-x-',
    'thread comment removed': 'xxxx',
    'thread comment deleted': 'xxxx',
    'thread commenter deleted': 'xxxx',
    'thread commenter blocked': 'x-x-',
    'thread post removed': 'xxxx',
    'thread post deleted': 'xxxx',
    'thread post sensitive': 'xxxx',
    'thread post nsfl': 'xxxx',
    'thread post author blocked': 'x-x-',
    'thread community sensitive': 'xxxx',
    'thread community nsfl': 'xxxx',
    'thread community deleted': 'xxxx',
    'thread community removed': 'xxxx',
    'thread community blocked': 'x-x-',
    'thread comment purged': 'xxxx',
    'thread names nobody': '----',
    'thread names V': 'x-x-',
    'thread names P': '----',
    'thread names deleted': 'xxxx',
    'thread names removed': 'xxxx',
    'thread names blocked': 'x-x-',
    'accept L': '----',
    'accept P': 'xx--',
    'accept V': 'x-x-',
    'accept sensitive': '-x-x',
    'accept nsfl': '-x-x',
    'accept P sensitive': 'xx-x',
    'accept deleted': 'xxxx',
    'accept removed': 'xxxx',
    'accept blocked': 'x-x-',
    'accept no community': '----',
    'reply from L': '----',
    'reply in L': '----',
    'ban from L': '----',
    'reply from P': '----',
    'reply in P': '----',
    'ban from P': '----',
    'reply from V': 'x-x-',
    'reply in V': 'x-x-',
    'ban from V': '----',
    'reply in blocked': 'x-x-',
    'reply in deleted': 'xxxx',
    'reply in removed': 'xxxx',
    'reply names nobody': '----',
    'mention from blocked': 'x-x-',
    'mention from deleted': '----',
    'removal by blocked': '----',
    'removal in deleted': 'xxxx',
    'restore in V': '----',
    'unban from P': '----',
  },
  counts: {
    blocking: { unread: 19, byGroup: { replies: 8, mentions: 1, content: 2, account: 8 }, marked: 19, undone: 19 },
    undeclared: { unread: 35, byGroup: { replies: 23, mentions: 2, content: 2, account: 8 }, marked: 35, undone: 35 },
  },
};
