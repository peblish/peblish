import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { comments, posts } from '../db/tables/content.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents, writeCounts } from '../testing/seed-az.ts';
import { seedPostWorld } from '../testing/seed-b1.ts';
import { seedChain, seedReply } from '../testing/seed-d.ts';
import { localUser, seedActor } from '../testing/seed.ts';
import { deleteComment } from './delete.ts';
import { findMentioned } from '../mentions/scan.ts';
import { maxCommentDepth } from './input.ts';
import { resolveReplyTarget, storeRemoteComment, updateRemoteComment, type RemoteComment } from './remote.ts';

beforeEach(truncateAll);

const commentRow = async (id: string) => (await db().select().from(comments).where(eq(comments.id, id)))[0]!;

async function world() {
  const w = await seedPostWorld();
  const principal = { kind: 'remote', actorId: w.people.remoteAuthor.id, announcedBy: null } as const;
  const postId = w.posts.remote.normal;
  const [post] = await db().select().from(posts).where(eq(posts.id, postId));
  const record = (extra: Partial<RemoteComment> = {}): RemoteComment => ({
    apId: 'https://lemmy.test/comment/1',
    inReplyToApId: post!.apId,
    bodyMd: null,
    contentHtml: '<p>Hello from <b>Lemmy</b></p>',
    language: 'en',
    publishedAt: new Date('2026-11-01T12:00:00Z'),
    editedAt: null,
    raw: { id: 'https://lemmy.test/comment/1', type: 'Note' },
    ...extra,
  });
  return { w, principal, postId, post: post!, record };
}

describe('resolveReplyTarget', () => {
  test('finds the post or the comment a Note replies to, by ap_id', async () => {
    const { w, post, postId } = await world();
    const parent = await seedReply(w.instances.lemmy, { id: postId }, null, w.people.remoteAuthor);
    const parentRow = await commentRow(parent.id);
    expect(await resolveReplyTarget(post.apId)).toEqual({ postId, parentId: null });
    expect(await resolveReplyTarget(parentRow.apId)).toEqual({ postId, parentId: parent.id });
    expect(await resolveReplyTarget('https://lemmy.test/comment/unknown')).toBeNull();
  });
});

describe('storeRemoteComment', () => {
  test('stores a peer comment as its author with sanitised HTML, the counts and comment.created (local false)', async () => {
    const { w, principal, postId, post, record } = await world();
    const subject = (await resolveReplyTarget(post.apId))!;
    const grant = await grantFor('comment.create', principal, subject);
    const stored = await storeRemoteComment(
      grant,
      record({ contentHtml: '<p>Hello <b>there</b></p><script>alert(1)</script>', publishedAt: null }),
    );
    expect(stored.created).toBe(true);
    const row = await commentRow(stored.id);
    expect(row).toMatchObject({
      apId: 'https://lemmy.test/comment/1',
      local: false,
      postId,
      parentId: null,
      authorId: w.people.remoteAuthor.id,
      instanceId: w.instances.lemmy.id,
      path: stored.id,
      bodyMd: null,
      language: 'en',
      distinguished: false,
      raw: { id: 'https://lemmy.test/comment/1', type: 'Note' },
    });
    expect(row.contentHtml).toContain('<b>there</b>');
    expect(row.contentHtml).not.toContain('script');
    // No published date: the receive time.
    expect(Math.abs(row.publishedAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect((await db().select().from(posts).where(eq(posts.id, postId)))[0]!.commentCount).toBe(1);
    expect(await outboxEvents()).toEqual([
      { type: 'comment.created', v: 1, commentId: stored.id, postId, authorId: w.people.remoteAuthor.id, local: false, parentId: null },
    ]);
  });

  test('renders the Markdown source when the peer sent one, and a reply nests under its parent', async () => {
    const { principal, postId, record } = await world();
    const top = await storeRemoteComment(
      await grantFor('comment.create', principal, { postId, parentId: null }),
      record({ bodyMd: 'A **bold** claim', contentHtml: '<p>ignored</p>' }),
    );
    expect(await commentRow(top.id)).toMatchObject({ bodyMd: 'A **bold** claim' });
    expect((await commentRow(top.id)).contentHtml).toContain('<strong>bold</strong>');
    const topRow = await commentRow(top.id);
    const reply = await storeRemoteComment(
      await grantFor('comment.create', principal, { postId, parentId: top.id }),
      record({ apId: 'https://lemmy.test/comment/2', inReplyToApId: topRow.apId }),
    );
    expect((await commentRow(reply.id)).path).toBe(`${top.id}.${reply.id}`);
    expect((await commentRow(top.id)).childCount).toBe(1);
  });

  test('a redelivered Create changes nothing', async () => {
    const { principal, postId, record } = await world();
    const subject = { postId, parentId: null };
    const first = await storeRemoteComment(await grantFor('comment.create', principal, subject), record());
    const before = await writeCounts();
    const again = await storeRemoteComment(await grantFor('comment.create', principal, subject), record());
    expect(again).toEqual({ id: first.id, created: false });
    expect(await writeCounts()).toEqual(before);
  });

  test('does not read the moderator flag from the document, and refuses a Note that replies to something else', async () => {
    const { w, principal, postId, record } = await world();
    const subject = { postId, parentId: null };
    const stored = await storeRemoteComment(await grantFor('comment.create', principal, subject), {
      ...record(),
      distinguished: true,
    } as RemoteComment);
    expect((await commentRow(stored.id)).distinguished).toBe(false);
    const other = await seedReply(w.instances.lemmy, { id: postId }, null, w.people.remoteAuthor);
    const grant = await grantFor('comment.create', principal, subject);
    await expect(
      storeRemoteComment(grant, record({ apId: 'https://lemmy.test/comment/9', inReplyToApId: (await commentRow(other.id)).apId })),
    ).rejects.toThrow(/does not reply to the grant subject/);
  });

  test('is for a remote author: a local one uses createComment', async () => {
    const { w, postId, record } = await world();
    const grant = await grantFor('comment.create', localUser(w.people.reader.id), { postId, parentId: null });
    await expect(storeRemoteComment(grant, record())).rejects.toThrow(/use createComment/);
  });

  test('the 51st level is refused for a remote reply with comment.depth_exceeded', async () => {
    const { w, principal, postId } = await world();
    const chain = await seedChain(w.instances.lemmy, { id: postId }, w.people.remoteAuthor, maxCommentDepth);
    const decision = await authorize('comment.create', principal, { postId, parentId: chain.at(-1)!.id });
    expect(decision).toEqual({ ok: false, reason: 'comment.depth_exceeded' });
    const ok49 = await authorize('comment.create', principal, { postId, parentId: chain.at(-2)!.id });
    expect(ok49.ok).toBe(true);
  });
});

describe('updateRemoteComment and a peer deleting its own comment', () => {
  async function stored() {
    const ctx = await world();
    const created = await storeRemoteComment(
      await grantFor('comment.create', ctx.principal, { postId: ctx.postId, parentId: null }),
      ctx.record(),
    );
    return { ...ctx, id: created.id };
  }

  test('replaces the body, keeps the published date, emits comment.updated and, unchanged, nothing', async () => {
    const { principal, record, id } = await stored();
    const grant = await grantFor('comment.update', principal, { commentId: id });
    const edited = new Date('2026-11-02T08:00:00Z');
    expect(await updateRemoteComment(grant, record({ contentHtml: '<p>Edited</p>', editedAt: edited }))).toEqual({ id, changed: true });
    expect(await commentRow(id)).toMatchObject({
      contentHtml: '<p>Edited</p>',
      editedAt: edited,
      publishedAt: new Date('2026-11-01T12:00:00Z'),
    });
    const before = await writeCounts();
    const again = await grantFor('comment.update', principal, { commentId: id });
    expect(await updateRemoteComment(again, record({ contentHtml: '<p>Edited</p>', editedAt: edited }))).toEqual({ id, changed: false });
    expect(await writeCounts()).toEqual(before);
    await expect(updateRemoteComment(again, record({ apId: 'https://lemmy.test/comment/other' }))).rejects.toThrow(/not this comment/);
  });

  test('an edit that only changes who is mentioned is an edit: the tags are stored and comment.updated goes out', async () => {
    const { w, principal, record, id, postId } = await stored();
    const mention = { type: 'Mention', href: w.people.reader.apId, name: `@${w.people.reader.name}@b1.test` };
    const tagged = record({ raw: { id: 'https://lemmy.test/comment/1', type: 'Note', tag: [mention] } });
    const grant = await grantFor('comment.update', principal, { commentId: id });
    expect(await updateRemoteComment(grant, tagged)).toEqual({ id, changed: true });
    const row = await commentRow(id);
    expect(row.raw).toEqual(tagged.raw);
    expect(await findMentioned(db(), { bodyMd: null, raw: row.raw, authorId: row.authorId })).toEqual([w.people.reader.id]);
    expect((await outboxEvents()).at(-1)).toEqual({
      type: 'comment.updated',
      v: 1,
      commentId: id,
      postId,
      authorId: w.people.remoteAuthor.id,
      local: false,
    });
    // The same tags again, in another order and repeated, change nothing.
    const again = await grantFor('comment.update', principal, { commentId: id });
    const before = await writeCounts();
    const repeated = record({ raw: { id: 'https://lemmy.test/comment/1', type: 'Note', tag: [mention, mention] } });
    expect(await updateRemoteComment(again, repeated)).toEqual({ id, changed: false });
    expect(await writeCounts()).toEqual(before);
  });

  test("the author's Delete is a soft delete, emitted as not local", async () => {
    const { w, principal, postId, id } = await stored();
    await deleteComment(await grantFor('comment.delete', principal, { commentId: id }), undefined);
    expect((await commentRow(id)).deletedAt).toBeInstanceOf(Date);
    expect((await outboxEvents()).at(-1)).toEqual({
      type: 'comment.deleted',
      v: 1,
      commentId: id,
      postId,
      authorId: w.people.remoteAuthor.id,
      local: false,
    });
  });

  test('a comment by someone else is not an author action', async () => {
    const { w, id } = await stored();
    const stranger = await seedActor(w.instances.lemmy, 'Person', 'stranger');
    const other = { kind: 'remote', actorId: stranger.id, announcedBy: null } as const;
    expect(await authorize('comment.update', other, { commentId: id })).toEqual({ ok: false, reason: 'comment.author_required' });
  });
});
