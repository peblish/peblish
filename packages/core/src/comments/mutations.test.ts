import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { comments, posts, votes } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { actors } from '../db/tables/actors.ts';
import { lockPost } from '../moderation/lock.ts';
import { banFromCommunity } from '../moderation/ban.ts';
import { removeContent } from '../moderation/remove.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents, writeCounts } from '../testing/seed-az.ts';
import { seedPostWorld } from '../testing/seed-b1.ts';
import { localUser } from '../testing/seed.ts';
import { Refused } from '../tx/refused.ts';
import { tx } from '../tx/tx.ts';
import { createCommentAs, deleteCommentAs, updateCommentAs } from './actions.ts';
import { createComment } from './create.ts';
import { deleteComment, restoreComment } from './delete.ts';
import { updateComment } from './edit.ts';
import { NewComment, commentMaxLength, maxCommentDepth } from './input.ts';

beforeEach(truncateAll);

/** The Postgres error code behind a Drizzle query error, if any. */
function postgresCode(error: unknown): unknown {
  return error instanceof Error && typeof error.cause === 'object' && error.cause !== null && 'code' in error.cause
    ? error.cause.code
    : undefined;
}

const commentRow = async (id: string) => (await db().select().from(comments).where(eq(comments.id, id)))[0]!;
const postRow = async (id: string) => (await db().select().from(posts).where(eq(posts.id, id)))[0]!;
const ok = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
};

/** Whether the comment's row and its newest outbox event were written by one transaction. */
async function sameTransaction(commentId: string): Promise<boolean> {
  const [same] = await db().execute<{ same: boolean }>(
    sql`select exists (select 1 from outbox o, comments c where c.id = ${commentId} and o.type = 'comment.restored'
      and (o.tx_id::text::numeric % 4294967296)::text = c.xmin::text) as same`,
  );
  return same?.same === true;
}

async function world() {
  const w = await seedPostWorld();
  return { w, reader: localUser(w.people.reader.id), postId: w.posts.local.normal, post: { id: w.posts.local.normal } };
}

describe('createComment', () => {
  test('writes the comment, the counts and comment.created in one transaction, rendering the body once', async () => {
    const { w, reader, postId } = await world();
    const grant = await grantFor('comment.create', reader, { postId, parentId: null });
    const { id, apId } = await createComment(grant, { bodyMd: 'Some **bold** text' });
    const row = await commentRow(id);
    expect(row).toMatchObject({
      apId: `https://feddit.test/ap/comment/${id}`,
      local: true,
      postId,
      parentId: null,
      authorId: w.people.reader.id,
      path: id,
      bodyMd: 'Some **bold** text',
      upvotes: 0,
      downvotes: 0,
      childCount: 0,
      distinguished: false,
    });
    expect(apId).toBe(row.apId);
    expect(row.contentHtml).toContain('<strong>bold</strong>');
    expect((await postRow(postId)).commentCount).toBe(1);
    expect(await outboxEvents()).toEqual([
      { type: 'comment.created', v: 1, commentId: id, postId, authorId: w.people.reader.id, local: true, parentId: null },
    ]);
    // The row and its event commit together: the row's xmin is the outbox row's transaction.
    const [same] = await db().execute<{ same: boolean }>(
      sql`select exists (select 1 from outbox o, comments c where c.id = ${id} and o.type = 'comment.created'
        and (o.tx_id::text::numeric % 4294967296)::text = c.xmin::text) as same`,
    );
    expect(same?.same).toBe(true);
  });

  test('a reply takes its parent path and counts for the post and for every comment above it', async () => {
    const { reader, postId } = await world();
    const reply = async (parentId: string | null) => ok(await createCommentAs(reader, { postId, parentId }, { bodyMd: 'x' })).id;
    const top = await reply(null);
    const child = await reply(top);
    const grandchild = await reply(child);
    expect((await commentRow(grandchild)).path).toBe(`${top}.${child}.${grandchild}`);
    expect((await commentRow(grandchild)).parentId).toBe(child);
    // child_count is every comment below, at any depth.
    expect(await Promise.all([top, child, grandchild].map(async (id) => (await commentRow(id)).childCount))).toEqual([2, 1, 0]);
    expect((await postRow(postId)).commentCount).toBe(3);
  });

  test('replies at the same moment, at different depths, all count (no lost update, no deadlock)', async () => {
    const { w, reader, postId } = await world();
    const top = ok(await createCommentAs(reader, { postId, parentId: null }, { bodyMd: 'top' })).id;
    const child = ok(await createCommentAs(reader, { postId, parentId: top }, { bodyMd: 'child' })).id;
    const people = [reader, ...[w.people.author, w.people.moderator, w.people.owner, w.people.admin].map((person) => localUser(person.id))];
    // Eight replies under top, eight under child, four new top-level comments.
    const parents = [...Array<string>(8).fill(top), ...Array<string>(8).fill(child), ...Array<null>(4).fill(null)];
    const results = await Promise.all(
      parents.map((parentId, index) => createCommentAs(people[index % people.length]!, { postId, parentId }, { bodyMd: `reply ${index}` })),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await postRow(postId)).commentCount).toBe(2 + parents.length);
    // Under top: child, its eight replies and the eight replies of top itself.
    expect((await commentRow(top)).childCount).toBe(1 + 8 + 8);
    expect((await commentRow(child)).childCount).toBe(8);
  });

  test("casts the author's own upvote, so a comment starts at a score of 1 like its peers'", async () => {
    const { w, reader, postId } = await world();
    const { id } = ok(await createCommentAs(reader, { postId, parentId: null }, { bodyMd: 'mine' }));
    expect(await commentRow(id)).toMatchObject({ upvotes: 1, downvotes: 0 });
    const [vote] = await db().select().from(votes).where(eq(votes.commentId, id));
    expect(vote).toMatchObject({ voterId: w.people.reader.id, value: 1 });
  });

  test('refuses what the boundary does not allow, and writes nothing', async () => {
    const { reader, postId } = await world();
    const grant = await grantFor('comment.create', reader, { postId, parentId: null });
    for (const input of [
      { bodyMd: '' },
      { bodyMd: ' \n\t ' },
      { bodyMd: 'x'.repeat(commentMaxLength + 1) },
      { bodyMd: 'ok', language: 'English' },
    ])
      await expect(createComment(grant, input)).rejects.toThrow();
    // Exactly the limit passes, counted as code points.
    await createComment(grant, { bodyMd: '😀'.repeat(commentMaxLength) });
    expect(await writeCounts()).toMatchObject({ outbox: 1 });
    expect(NewComment.allows({ bodyMd: '😀'.repeat(commentMaxLength + 1) })).toBe(false);
  });

  describe('the 51st level', () => {
    test('is refused with comment.depth_exceeded, and the 50th is not', async () => {
      const { reader, postId } = await world();
      let parentId: string | null = null;
      for (let level = 1; level <= maxCommentDepth; level++) {
        const { id }: { id: string } = ok(await createCommentAs(reader, { postId, parentId }, { bodyMd: `level ${level}` }));
        expect((await commentRow(id)).path.split('.').length).toBe(level);
        parentId = id;
      }
      const before = await writeCounts();
      expect(await createCommentAs(reader, { postId, parentId }, { bodyMd: 'level 51' })).toEqual({
        ok: false,
        reason: 'comment.depth_exceeded',
      });
      expect(await writeCounts()).toEqual(before);
      expect((await postRow(postId)).commentCount).toBe(maxCommentDepth);
    });
  });

  describe('a change between authorize() and the write refuses the stale grant and writes nothing', () => {
    test('a lock', async () => {
      const { w, reader, postId } = await world();
      const stale = await grantFor('comment.create', reader, { postId, parentId: null });
      await lockPost(await grantFor('mod.lock', localUser(w.people.moderator.id), { postId }), { reason: 'Heated' });
      const before = await writeCounts();
      const attempt = createComment(stale, { bodyMd: 'Too late' });
      await expect(attempt).rejects.toBeInstanceOf(Refused);
      await expect(attempt).rejects.toMatchObject({ action: 'comment.create', reason: 'post.locked' });
      expect(await writeCounts()).toEqual(before);
      expect((await postRow(postId)).commentCount).toBe(0);
    });

    test('a ban', async () => {
      const { w, reader, postId } = await world();
      const stale = await grantFor('comment.create', reader, { postId, parentId: null });
      await banFromCommunity(
        await grantFor('mod.ban', localUser(w.people.moderator.id), {
          communityId: w.communities.open.id,
          targetActorId: w.people.reader.id,
        }),
        { reason: 'Spam' },
      );
      await expect(createComment(stale, { bodyMd: 'Too late' })).rejects.toMatchObject({ reason: 'community.banned' });
      expect((await postRow(postId)).commentCount).toBe(0);
    });

    test('a delete of the comment replied to', async () => {
      const { w, reader, postId } = await world();
      const parent = ok(await createCommentAs(reader, { postId, parentId: null }, { bodyMd: 'parent' })).id;
      const stale = await grantFor('comment.create', localUser(w.people.author.id), { postId, parentId: parent });
      ok(await deleteCommentAs(reader, parent));
      await expect(createComment(stale, { bodyMd: 'Too late' })).rejects.toMatchObject({ reason: 'target.deleted' });
      expect((await commentRow(parent)).childCount).toBe(0);
    });
  });

  test('an unverified email is refused before the community row is read or locked', async () => {
    const { w, postId } = await world();
    const nowait = (communityId: string) =>
      writer().execute(sql`select id from ${actors} where id = ${communityId} for no key update nowait`);
    const attempt = async (who: { id: string }) => {
      let reason: string | undefined;
      let probe: unknown;
      await tx(async (t) => {
        const decision = await authorize('comment.create', localUser(who.id), { postId, parentId: null }, { db: t.db, lock: true });
        if (!decision.ok) reason = decision.reason;
        // Another connection tries for the community row while this transaction is still open.
        probe = await nowait(w.communities.open.id).then(() => 'free', postgresCode);
      });
      return { reason, probe };
    };
    expect(await attempt(w.people.unverified)).toEqual({ reason: 'auth.email_unverified', probe: 'free' });
    // Control: for a verified person the same probe finds the row locked (55P03, lock_not_available).
    expect(await attempt(w.people.reader)).toEqual({ reason: undefined, probe: '55P03' });
  });
});

describe('updateComment', () => {
  test('replaces the body, renders it again, marks it edited and emits comment.updated', async () => {
    const { w, reader, postId } = await world();
    const { id } = ok(await createCommentAs(reader, { postId, parentId: null }, { bodyMd: 'before' }));
    const result = ok(await updateCommentAs(reader, id, { bodyMd: 'after **edit**' }));
    expect(result.changed).toBe(true);
    const row = await commentRow(id);
    expect(row).toMatchObject({ bodyMd: 'after **edit**', path: id });
    expect(row.contentHtml).toContain('<strong>edit</strong>');
    expect(row.editedAt).toBeInstanceOf(Date);
    expect((await outboxEvents()).at(-1)).toEqual({
      type: 'comment.updated',
      v: 1,
      commentId: id,
      postId,
      authorId: w.people.reader.id,
      local: true,
    });
  });

  test('an edit that changes nothing writes nothing and emits nothing', async () => {
    const { reader, postId } = await world();
    const { id } = ok(await createCommentAs(reader, { postId, parentId: null }, { bodyMd: 'same' }));
    const before = await writeCounts();
    expect(ok(await updateCommentAs(reader, id, { bodyMd: 'same' })).changed).toBe(false);
    expect(await writeCounts()).toEqual(before);
    expect((await commentRow(id)).editedAt).toBeNull();
  });

  test('refuses the others, an empty body and a body past the limit', async () => {
    const { w, reader, postId } = await world();
    const { id } = ok(await createCommentAs(reader, { postId, parentId: null }, { bodyMd: 'mine' }));
    expect(await updateCommentAs(localUser(w.people.author.id), id, { bodyMd: 'not yours' })).toEqual({
      ok: false,
      reason: 'comment.author_required',
    });
    const grant = await grantFor('comment.update', reader, { commentId: id });
    await expect(updateComment(grant, { bodyMd: '  ' })).rejects.toThrow();
    await expect(updateComment(grant, { bodyMd: 'x'.repeat(commentMaxLength + 1) })).rejects.toThrow();
    expect((await commentRow(id)).bodyMd).toBe('mine');
  });
});

describe('deleteComment', () => {
  test('is soft: the row, its path, its replies and every count stay, and comment.deleted is emitted', async () => {
    const { w, reader, postId } = await world();
    const parent = ok(await createCommentAs(reader, { postId, parentId: null }, { bodyMd: 'parent' })).id;
    const child = ok(await createCommentAs(localUser(w.people.author.id), { postId, parentId: parent }, { bodyMd: 'child' })).id;
    ok(await deleteCommentAs(reader, parent));
    expect(await commentRow(parent)).toMatchObject({ bodyMd: 'parent', path: parent, childCount: 1 });
    expect((await commentRow(parent)).deletedAt).toBeInstanceOf(Date);
    expect(await commentRow(child)).toMatchObject({ parentId: parent, deletedAt: null });
    expect((await postRow(postId)).commentCount).toBe(2);
    expect((await outboxEvents()).at(-1)).toEqual({
      type: 'comment.deleted',
      v: 1,
      commentId: parent,
      postId,
      authorId: w.people.reader.id,
      local: true,
    });
    // Nothing more to do with it: no second delete, no edit, no reply.
    expect(await deleteCommentAs(reader, parent)).toEqual({ ok: false, reason: 'target.deleted' });
    expect(await updateCommentAs(reader, parent, { bodyMd: 'back' })).toEqual({ ok: false, reason: 'target.deleted' });
    expect(await createCommentAs(reader, { postId, parentId: parent }, { bodyMd: 'late' })).toEqual({
      ok: false,
      reason: 'target.deleted',
    });
  });

  test("a moderator's removal is not the author's to undo, even one that lands after authorize()", async () => {
    const { w, reader, postId } = await world();
    const { id } = ok(await createCommentAs(reader, { postId, parentId: null }, { bodyMd: 'rude' }));
    const stale = await grantFor('comment.delete', reader, { commentId: id });
    const moderator = localUser(w.people.moderator.id);
    await removeContent(await grantFor('mod.remove', moderator, { target: { kind: 'comment', id } }), { reason: 'Rule 1' });
    await expect(deleteComment(stale, undefined)).rejects.toMatchObject({ action: 'comment.delete', reason: 'target.removed' });
    expect(await deleteCommentAs(reader, id)).toEqual({ ok: false, reason: 'target.removed' });
    expect((await commentRow(id)).deletedAt).toBeNull();
  });
});

describe('restoreComment', () => {
  test('takes the delete back: the text is live again, no count changes, comment.restored is emitted in one transaction', async () => {
    const { w, reader, postId } = await world();
    const parent = ok(await createCommentAs(reader, { postId, parentId: null }, { bodyMd: 'parent' })).id;
    ok(await createCommentAs(localUser(w.people.author.id), { postId, parentId: parent }, { bodyMd: 'child' }));
    ok(await deleteCommentAs(reader, parent));
    const counts = { post: (await postRow(postId)).commentCount, parent: (await commentRow(parent)).childCount };
    const grant = await grantFor('comment.restore', reader, { commentId: parent });
    await restoreComment(grant, undefined);
    expect(await commentRow(parent)).toMatchObject({ bodyMd: 'parent', deletedAt: null, path: parent, childCount: counts.parent });
    expect((await postRow(postId)).commentCount).toBe(counts.post);
    expect((await outboxEvents()).at(-1)).toEqual({
      type: 'comment.restored',
      v: 1,
      commentId: parent,
      postId,
      authorId: w.people.reader.id,
      local: true,
    });
    expect(await sameTransaction(parent)).toBe(true);
    // Live again: it takes an edit and a reply, and a second delete.
    expect(ok(await updateCommentAs(reader, parent, { bodyMd: 'back' })).changed).toBe(true);
    ok(await createCommentAs(reader, { postId, parentId: parent }, { bodyMd: 'reply' }));
  });

  test('refuses a comment that is not deleted, and one a moderator removed', async () => {
    const { w, reader, postId } = await world();
    const { id } = ok(await createCommentAs(reader, { postId, parentId: null }, { bodyMd: 'live' }));
    const refusal = async () => {
      const decision = await authorize('comment.restore', reader, { commentId: id });
      return decision.ok ? 'allow' : decision.reason;
    };
    expect(await refusal()).toBe('comment.not_deleted');
    const moderator = localUser(w.people.moderator.id);
    await removeContent(await grantFor('mod.remove', moderator, { target: { kind: 'comment', id } }), { reason: 'Rule 1' });
    expect(await refusal()).toBe('target.removed');
  });

  test('a grant that is used twice is refused the second time, and writes nothing', async () => {
    const { reader, postId } = await world();
    const { id } = ok(await createCommentAs(reader, { postId, parentId: null }, { bodyMd: 'mine' }));
    ok(await deleteCommentAs(reader, id));
    const first = await grantFor('comment.restore', reader, { commentId: id });
    const second = await grantFor('comment.restore', reader, { commentId: id });
    await restoreComment(first, undefined);
    const before = await writeCounts();
    await expect(restoreComment(second, undefined)).rejects.toMatchObject({ action: 'comment.restore', reason: 'comment.not_deleted' });
    expect(await writeCounts()).toEqual(before);
  });
});
