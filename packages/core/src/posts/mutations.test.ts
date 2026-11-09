import { parseEvent } from '@peblish/schema/events';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents, seedComment, writeCounts } from '../testing/seed-az.ts';
import { sameTransaction, seedPostWorld } from '../testing/seed-b1.ts';
import { localUser } from '../testing/seed.ts';
import { Refused } from '../tx/refused.ts';
import { tx } from '../tx/tx.ts';
import { createPost } from './create.ts';
import { deletePost, restorePost } from './delete.ts';
import { updatePost } from './edit.ts';

beforeEach(truncateAll);

/** The Postgres error code behind a Drizzle query error, if any. */
function postgresCode(error: unknown): unknown {
  return error instanceof Error && typeof error.cause === 'object' && error.cause !== null && 'code' in error.cause
    ? error.cause.code
    : undefined;
}

const postRow = async (id: string) => (await db().select().from(posts).where(eq(posts.id, id)))[0]!;
const lastEvent = async () => (await outboxEvents()).at(-1);

async function create(input: Parameters<typeof createPost>[1], community: 'open' | 'restricted' = 'open') {
  const world = await seedPostWorld();
  const author = localUser(world.people.author.id);
  const grant = await grantFor('post.create', author, { communityId: world.communities[community].id });
  return { world, author, grant, input };
}

describe('createPost', () => {
  test("refuses a remote author's grant: a peer's post goes through storeRemotePost, and nothing is written", async () => {
    const world = await seedPostWorld();
    const grant = await grantFor(
      'post.create',
      { kind: 'remote', actorId: world.people.remoteAuthor.id, announcedBy: null },
      { communityId: world.communities.remote.id },
    );
    await expect(createPost(grant, { title: 'From a peer' })).rejects.toMatchObject({ name: 'Refused', reason: 'auth.required' });
    expect(await db().select({ id: posts.id }).from(posts).where(eq(posts.title, 'From a peer'))).toEqual([]);
    expect(await outboxEvents()).toEqual([]);
  });

  test('writes the post and post.created in one transaction, rendering the body once', async () => {
    const { world, grant } = await create({ title: 'Hello' });
    const { id, apId } = await createPost(grant, {
      title: '  Hello \n there  ',
      url: 'https://example.test/a',
      bodyMd: 'Some **bold** text',
    });
    const row = await postRow(id);
    expect(row).toMatchObject({
      apId,
      title: 'Hello there',
      url: 'https://example.test/a',
      local: true,
      authorId: world.people.author.id,
      communityId: world.communities.open.id,
      bodyMd: 'Some **bold** text',
      sensitive: false,
      nsfl: false,
      upvotes: 0,
      downvotes: 0,
    });
    expect(row.apId).toBe(`https://feddit.test/ap/post/${id}`);
    expect(row.contentHtml).toContain('<strong>bold</strong>');
    expect(await outboxEvents()).toEqual([
      { type: 'post.created', v: 1, postId: id, communityId: world.communities.open.id, authorId: world.people.author.id, local: true },
    ]);
    expect(await sameTransaction('posts', id, 'post.created')).toBe(true);
  });

  test('a post in a sensitive or NSFL community is that too; NSFL makes a post sensitive', async () => {
    const { world, grant } = await create({ title: 'x' });
    await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, world.communities.open.id));
    expect(await postRow((await createPost(grant, { title: 'In a sensitive community' })).id)).toMatchObject({
      sensitive: true,
      nsfl: false,
    });
    await writer().update(actors).set({ sensitive: false, nsfl: true }).where(eq(actors.id, world.communities.open.id));
    expect(await postRow((await createPost(grant, { title: 'In an NSFL community' })).id)).toMatchObject({ sensitive: true, nsfl: true });
    await writer().update(actors).set({ nsfl: false }).where(eq(actors.id, world.communities.open.id));
    expect(await postRow((await createPost(grant, { title: 'Marked NSFL', nsfl: true })).id)).toMatchObject({
      sensitive: true,
      nsfl: true,
    });
    expect(await postRow((await createPost(grant, { title: 'Plain' })).id)).toMatchObject({ sensitive: false, nsfl: false });
  });

  test('refuses what the boundary does not allow, and writes nothing', async () => {
    const { grant } = await create({ title: 'x' });
    const bad = [
      { title: '' },
      { title: ' \n ' },
      { title: 'x'.repeat(201) },
      { title: 'ok', url: 'javascript:alert(1)' },
      { title: 'ok', url: 'https://user:pass@example.test/' },
      { title: 'ok', url: 'ftp://example.test/file' },
      { title: 'ok', thumbnailUrl: 'data:image/png;base64,AAAA' },
      { title: 'ok', urlContentType: 'not a type' },
      { title: 'ok', language: 'English' },
      { title: 'ok', bodyMd: 'x'.repeat(50_001) },
    ];
    for (const input of bad) await expect(createPost(grant, input)).rejects.toThrow();
    // Exactly the limits pass: 200 characters counted as code points, 50,000 of body.
    await createPost(grant, { title: '😀'.repeat(200), bodyMd: 'x'.repeat(50_000) });
    expect(await writeCounts()).toMatchObject({ outbox: 1 });
  });

  test('a restriction that lands after authorize() refuses the post', async () => {
    const { world, grant } = await create({ title: 'x' });
    await writer().update(actors).set({ postingRestrictedToMods: true }).where(eq(actors.id, world.communities.open.id));
    await expect(createPost(grant, { title: 'Too late' })).rejects.toMatchObject({
      name: 'Refused',
      reason: 'community.posting_restricted',
    });
    expect(await writeCounts()).toMatchObject({ outbox: 0 });
  });

  test('an unverified email is refused before the community row is read or locked', async () => {
    const world = await seedPostWorld();
    const nowait = (communityId: string) =>
      writer().execute(sql`select id from ${actors} where id = ${communityId} for no key update nowait`);
    const attempt = async (who: { id: string }) => {
      let reason: string | undefined;
      let probe: unknown;
      await tx(async (t) => {
        const decision = await authorize(
          'post.create',
          localUser(who.id),
          { communityId: world.communities.open.id },
          { db: t.db, lock: true },
        );
        if (!decision.ok) reason = decision.reason;
        // Another connection tries for the community row while this transaction is still open.
        probe = await nowait(world.communities.open.id).then(() => 'free', postgresCode);
      });
      return { reason, probe };
    };
    expect(await attempt(world.people.unverified)).toEqual({ reason: 'auth.email_unverified', probe: 'free' });
    // Control: for a verified person the same probe finds the row locked (55P03, lock_not_available).
    expect(await attempt(world.people.reader)).toEqual({ reason: undefined, probe: '55P03' });
  });
});

describe('updatePost', () => {
  test('changes the fields sent, renders the body again, marks the edit and emits post.updated', async () => {
    const { world, author, grant } = await create({ title: 'x' });
    const { id } = await createPost(grant, { title: 'First', bodyMd: 'one', url: 'https://example.test/a' });
    const before = await postRow(id);
    expect(before.editedAt).toBeNull();
    const edit = await grantFor('post.update', author, { postId: id });
    expect(await updatePost(edit, { title: 'Second', bodyMd: 'two **bold**', url: null })).toEqual({ changed: true });
    const row = await postRow(id);
    expect(row).toMatchObject({ title: 'Second', bodyMd: 'two **bold**', url: null, apId: before.apId, publishedAt: before.publishedAt });
    expect(row.contentHtml).toContain('<strong>bold</strong>');
    expect(row.editedAt).toBeInstanceOf(Date);
    expect(await lastEvent()).toEqual({
      type: 'post.updated',
      v: 1,
      postId: id,
      communityId: world.communities.open.id,
      authorId: world.people.author.id,
      local: true,
    });
    expect(await sameTransaction('posts', id, 'post.updated')).toBe(true);
  });

  test('an edit that changes nothing writes nothing and emits nothing; a sensitive community keeps its posts sensitive', async () => {
    const { world, author, grant } = await create({ title: 'x' });
    await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, world.communities.open.id));
    const { id } = await createPost(grant, { title: 'Same', bodyMd: 'body' });
    const edit = await grantFor('post.update', author, { postId: id });
    expect(await updatePost(edit, { title: 'Same', bodyMd: 'body', sensitive: false })).toEqual({ changed: false });
    const row = await postRow(id);
    expect(row).toMatchObject({ sensitive: true, editedAt: null });
    expect(await outboxEvents()).toHaveLength(1);
  });

  test('refuses a bad edit, and an edit after a moderator removed the post', async () => {
    const { author, grant } = await create({ title: 'x' });
    const { id } = await createPost(grant, { title: 'Mine' });
    const edit = await grantFor('post.update', author, { postId: id });
    await expect(updatePost(edit, { url: 'javascript:alert(1)' })).rejects.toThrow();
    await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, id));
    await expect(updatePost(edit, { title: 'Sneaky' })).rejects.toMatchObject({ name: 'Refused', reason: 'target.removed' });
    expect((await postRow(id)).title).toBe('Mine');
  });
});

describe('deletePost and restorePost', () => {
  test('a delete is soft: the row, its ap_id and its comments stay; restore undoes it; each emits in its own transaction', async () => {
    const { world, author, grant } = await create({ title: 'x' });
    const { id } = await createPost(grant, { title: 'Doomed', bodyMd: 'text' });
    const comment = await seedComment(world.instances.local, { id }, world.people.reader);
    const before = await postRow(id);

    await deletePost(await grantFor('post.delete', author, { postId: id }));
    const deleted = await postRow(id);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted).toMatchObject({ apId: before.apId, title: 'Doomed', bodyMd: 'text' });
    expect(await sameTransaction('posts', id, 'post.deleted')).toBe(true);
    // Deleting again is refused with the exact reason, and a comment still hangs off the post.
    expect(await authorize('post.delete', author, { postId: id })).toEqual({ ok: false, reason: 'target.deleted' });
    expect(
      (await db().execute<{ postId: string }>(sql`select post_id as "postId" from comments where id = ${comment.id}`))[0]?.postId,
    ).toBe(id);

    await restorePost(await grantFor('post.restore', author, { postId: id }));
    expect((await postRow(id)).deletedAt).toBeNull();
    expect(await sameTransaction('posts', id, 'post.restored')).toBe(true);
    expect(await authorize('post.restore', author, { postId: id })).toEqual({ ok: false, reason: 'post.not_deleted' });

    const base = { v: 1, postId: id, communityId: world.communities.open.id, authorId: world.people.author.id, local: true };
    expect(await outboxEvents()).toEqual([
      { type: 'post.created', ...base },
      { type: 'post.deleted', ...base },
      { type: 'post.restored', ...base },
    ]);
  });

  test('a delete that lands after authorize() is refused when applied twice (a double submit)', async () => {
    const { author, grant } = await create({ title: 'x' });
    const { id } = await createPost(grant, { title: 'Twice' });
    const stale = await grantFor('post.delete', author, { postId: id });
    await deletePost(stale);
    await expect(deletePost(stale)).rejects.toBeInstanceOf(Refused);
    await expect(deletePost(stale)).rejects.toMatchObject({ reason: 'target.deleted' });
    expect((await outboxEvents()).map(parseEvent).filter((event) => event.type === 'post.deleted')).toHaveLength(1);
  });
});
