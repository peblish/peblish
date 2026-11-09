import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { createComment } from '../comments/create.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { deletionLedger } from '../db/tables/site.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { outboxEvents, seedComment, seedPost } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { defineMutation } from '../tx/mutation.ts';
import { deleteRemoteActor, undeleteRemoteActor } from './actors.ts';
import { deleteRemoteObject } from './objects.ts';

/** The local instance, a Lemmy-like peer with a person who wrote a post and two comments, and a local post of ours. */
async function world() {
  const local = await seedLocalInstance();
  const lemmy = await seedInstance('lemmy.test', false);
  const community = await seedActor(lemmy, 'Group', 'lab', { apId: 'https://lemmy.test/c/lab' });
  const bob = await seedActor(lemmy, 'Person', 'bob', { apId: 'https://lemmy.test/u/bob', displayName: 'Bob', summaryHtml: '<p>hi</p>' });
  const carol = await seedActor(lemmy, 'Person', 'carol', { apId: 'https://lemmy.test/u/carol' });
  const post = await seedPost(lemmy, community, bob, { apId: 'https://lemmy.test/post/1' });
  const reply = await seedComment(lemmy, post, bob, { apId: 'https://lemmy.test/comment/1' });
  const other = await seedComment(lemmy, post, carol, { apId: 'https://lemmy.test/comment/2' });
  const mine = await seedPost(local.instance, community, carol, { apId: 'https://rem.test/post/1' });
  const principal = await local.importer();
  const grant = async <A extends 'remote.actor_delete' | 'remote.actor_undelete' | 'remote.object_delete'>(action: A, apId: string) => {
    const decision = await authorize(action, principal, { apId });
    if (!decision.ok) throw new Error(decision.reason);
    return decision.grant;
  };
  return { local, lemmy, bob, carol, community, post, reply, other, mine, grant };
}

const ledger = async () => (await db().select().from(deletionLedger)).sort((a, b) => a.id - b.id);
const types = async () => (await outboxEvents()).map((event) => (event as { type: string }).type);

beforeEach(truncateAll);

describe('a remote account’s deletion', () => {
  test('soft-deletes the actor, scrubs its profile, keeps its content, and records it in the ledger', async () => {
    const w = await world();
    const grant = await w.grant('remote.actor_delete', w.bob.apId);
    expect(await deleteRemoteActor(grant, { cause: 'Delete' })).toEqual({ actorChanged: true, contentRemoved: 0 });

    const [bob] = await db().select().from(actors).where(eq(actors.id, w.bob.id));
    expect(bob).toMatchObject({ displayName: null, summaryHtml: null });
    expect(bob?.deletedAt).toBeInstanceOf(Date);
    expect((await db().select().from(posts).where(eq(posts.id, w.post.id)))[0]?.deletedAt).toBeNull();
    expect((await db().select().from(comments).where(eq(comments.id, w.reply.id)))[0]?.deletedAt).toBeNull();
    expect(await ledger()).toMatchObject([
      {
        subjectKind: 'actor',
        subjectId: w.bob.id,
        subjectApId: w.bob.apId,
        reason: 'remote.actor_deleted',
        details: { remote: true, cause: 'Delete', removeContent: false },
      },
    ]);
    expect(await types()).toEqual(['actor.deleted']);
  });

  test('with content removal, marks the actor’s posts and comments deleted and nobody else’s', async () => {
    const w = await world();
    const grant = await w.grant('remote.actor_delete', w.bob.apId);
    expect(await deleteRemoteActor(grant, { removeContent: true })).toEqual({ actorChanged: true, contentRemoved: 2 });

    const deleted = async () => ({
      post: (await db().select().from(posts).where(eq(posts.id, w.post.id)))[0]?.deletedAt,
      reply: (await db().select().from(comments).where(eq(comments.id, w.reply.id)))[0]?.deletedAt,
      other: (await db().select().from(comments).where(eq(comments.id, w.other.id)))[0]?.deletedAt,
    });
    const after = await deleted();
    expect(after.post).toBeInstanceOf(Date);
    expect(after.reply).toBeInstanceOf(Date);
    expect(after.other).toBeNull();
    // One ledger row for the account, saying its content went too, so a restore deletes it as well.
    expect(await ledger()).toMatchObject([{ subjectKind: 'actor', details: { removeContent: true } }]);
    expect(await types()).toEqual(['actor.deleted', 'post.deleted', 'comment.deleted']);
  });

  test('a second Delete changes nothing and records nothing; a community keeps its content', async () => {
    const w = await world();
    await deleteRemoteActor(await w.grant('remote.actor_delete', w.bob.apId), { removeContent: true });
    expect(await deleteRemoteActor(await w.grant('remote.actor_delete', w.bob.apId))).toEqual({ actorChanged: false, contentRemoved: 0 });
    expect(await ledger()).toHaveLength(1);

    // removeContent means nothing for a community: its content is withheld with it.
    await deleteRemoteActor(await w.grant('remote.actor_delete', w.community.apId), { removeContent: true });
    expect((await db().select().from(posts).where(eq(posts.id, w.post.id)))[0]?.deletedAt).not.toBeNull(); // bob's, already gone
    expect((await db().select().from(posts).where(eq(posts.id, w.mine.id)))[0]?.deletedAt).toBeNull();
  });

  test('an explicit undelete brings the actor back, and the ledger ends with the undelete', async () => {
    const w = await world();
    await deleteRemoteActor(await w.grant('remote.actor_delete', w.bob.apId));
    expect(await undeleteRemoteActor(await w.grant('remote.actor_undelete', w.bob.apId))).toEqual({ undeleted: true, signedDelete: false });
    expect((await db().select().from(actors).where(eq(actors.id, w.bob.id)))[0]?.deletedAt).toBeNull();
    expect((await ledger()).map((row) => row.reason)).toEqual(['remote.actor_deleted', 'remote.actor_undeleted']);
    // Nothing to undo now.
    expect(await undeleteRemoteActor(await w.grant('remote.actor_undelete', w.bob.apId))).toEqual({
      undeleted: false,
      signedDelete: false,
    });
    expect(await ledger()).toHaveLength(2);
  });
});

describe('removing a deleted account’s content', () => {
  test('is independent of the actor’s state: a Delete with removeData after a Tombstone removes the content and is recorded', async () => {
    const w = await world();
    const elsewhere = await seedPost(w.lemmy, w.community, w.carol, { apId: 'https://lemmy.test/post/2' });
    const comment = await seedComment(w.lemmy, elsewhere, w.bob, { apId: 'https://lemmy.test/comment/9' });
    const grant = () => w.grant('remote.actor_delete', w.bob.apId);

    expect(await deleteRemoteActor(await grant(), { cause: 'Tombstone' })).toEqual({ actorChanged: true, contentRemoved: 0 });
    expect(await deleteRemoteActor(await grant(), { removeContent: true, cause: 'Delete' })).toEqual({
      actorChanged: false,
      contentRemoved: 3,
    });
    const gone = async (id: string) => (await db().select({ at: comments.deletedAt }).from(comments).where(eq(comments.id, id)))[0]?.at;
    expect(await gone(w.reply.id)).toBeInstanceOf(Date);
    expect(await gone(comment.id)).toBeInstanceOf(Date); // on a post of someone else
    expect(await gone(w.other.id)).toBeNull();
    expect((await db().select().from(posts).where(eq(posts.id, w.post.id)))[0]?.deletedAt).toBeInstanceOf(Date);
    expect((await db().select().from(posts).where(eq(posts.id, elsewhere.id)))[0]?.deletedAt).toBeNull();

    // The stronger request is recorded, so a restore removes the content.
    expect(await ledger()).toMatchObject([
      { details: { cause: 'Tombstone', removeContent: false } },
      { details: { cause: 'Delete', removeContent: true } },
    ]);
    expect(await types()).toEqual(['actor.deleted', 'post.deleted', 'comment.deleted', 'comment.deleted']);

    // Asking again finds nothing left and records nothing.
    expect(await deleteRemoteActor(await grant(), { removeContent: true, cause: 'Delete' })).toEqual({
      actorChanged: false,
      contentRemoved: 0,
    });
    expect(await ledger()).toHaveLength(2);
  });

  test('records a signed Delete over a Tombstone, and nothing for a weaker request', async () => {
    const w = await world();
    const grant = () => w.grant('remote.actor_delete', w.bob.apId);
    await deleteRemoteActor(await grant(), { cause: 'Tombstone' });
    await deleteRemoteActor(await grant(), { cause: 'Tombstone' });
    expect(await ledger()).toHaveLength(1);
    await deleteRemoteActor(await grant(), { cause: 'Delete' });
    expect(await ledger()).toMatchObject([{ details: { cause: 'Tombstone' } }, { details: { cause: 'Delete' } }]);
    await deleteRemoteActor(await grant(), { cause: 'Tombstone' });
    expect(await ledger()).toHaveLength(2);
  });

  test('after an undelete, a new deletion is recorded afresh', async () => {
    const w = await world();
    await deleteRemoteActor(await w.grant('remote.actor_delete', w.bob.apId), { cause: 'Delete', removeContent: true });
    await undeleteRemoteActor(await w.grant('remote.actor_undelete', w.bob.apId));
    await deleteRemoteActor(await w.grant('remote.actor_delete', w.bob.apId), { cause: 'Tombstone' });
    expect((await ledger()).map((row) => row.reason)).toEqual(['remote.actor_deleted', 'remote.actor_undeleted', 'remote.actor_deleted']);
    // The Tombstone is all that counts since the undelete: a refresh may restore it, a signed Delete's was taken back.
    expect(await undeleteRemoteActor(await w.grant('remote.actor_undelete', w.bob.apId), { via: 'refresh' })).toEqual({
      undeleted: true,
      signedDelete: false,
    });
  });

  test('a refresh may not undo the actor’s signed Delete, but its own Undo may', async () => {
    const w = await world();
    await deleteRemoteActor(await w.grant('remote.actor_delete', w.bob.apId), { cause: 'Delete' });
    expect(await undeleteRemoteActor(await w.grant('remote.actor_undelete', w.bob.apId), { via: 'refresh' })).toEqual({
      undeleted: false,
      signedDelete: true,
    });
    expect((await db().select().from(actors).where(eq(actors.id, w.bob.id)))[0]?.deletedAt).toBeInstanceOf(Date);
    expect(await undeleteRemoteActor(await w.grant('remote.actor_undelete', w.bob.apId))).toEqual({ undeleted: true, signedDelete: false });
  });
});

describe('the lock protocol of a bulk removal', () => {
  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { open, opened };
  };
  const someoneWaitsOnALock = async () => {
    const [row] = await db().execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    return (row?.waiting ?? 0) > 0;
  };

  test('the actor is tombstoned first, and its row is free while content waits for the community’s lock', async () => {
    const w = await world();
    const held = gate();
    const release = gate();
    const holder = writer().transaction(async (t) => {
      await t.select({ id: actors.id }).from(actors).where(eq(actors.id, w.community.id)).for('no key update');
      held.open();
      await release.opened;
    });
    await held.opened;
    const removal = deleteRemoteActor(await w.grant('remote.actor_delete', w.bob.apId), { removeContent: true });
    try {
      await expect.poll(someoneWaitsOnALock).toBe(true);
      // The tombstone has committed, and nothing holds bob's row while the removal waits.
      expect((await db().select().from(actors).where(eq(actors.id, w.bob.id)))[0]?.deletedAt).toBeInstanceOf(Date);
      await writer().transaction((t) => t.execute(sql`select 1 from actors where id = ${w.bob.id} for no key update nowait`));
      expect((await db().select().from(comments).where(eq(comments.id, w.reply.id)))[0]?.deletedAt).toBeNull();
    } finally {
      release.open();
    }
    await holder;
    expect(await removal).toEqual({ actorChanged: true, contentRemoved: 2 });
  });

  test('a reply that holds the community and the post commits first; the removal follows it, and nothing deadlocks', async () => {
    const w = await world();
    const dana = await seedActor(w.local.instance, 'Person', 'dana');
    const decision = await authorize('comment.create', localUser(dana.id), { postId: w.post.id, parentId: w.reply.id });
    if (!decision.ok) throw new Error(decision.reason);
    const locked = gate();
    const release = gate();
    const slowReply = defineMutation({
      action: 'comment.create',
      emits: ['comment.created'],
      recheck: true,
      async run(t, grant, _input: null) {
        locked.open();
        await release.opened;
        return createComment.within(t, grant, { bodyMd: 'A reply to the account about to go' });
      },
    });
    const reply = slowReply(decision.grant, null);
    await locked.opened;
    const removal = deleteRemoteActor(await w.grant('remote.actor_delete', w.bob.apId), { removeContent: true });
    try {
      await expect.poll(someoneWaitsOnALock).toBe(true);
    } finally {
      release.open();
    }
    const [{ id }, removed] = await Promise.all([reply, removal]);
    expect(removed).toEqual({ actorChanged: true, contentRemoved: 2 });
    const rows = await db().select().from(comments).where(eq(comments.postId, w.post.id));
    expect(rows.find((row) => row.id === id)?.deletedAt).toBeNull();
    expect(rows.find((row) => row.id === w.reply.id)?.deletedAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.id === w.reply.id)?.childCount).toBe(1);
  });
});

describe('a remote object its server no longer serves', () => {
  test('a post is soft-deleted once, with a ledger row and a post.deleted event, and its comments stay', async () => {
    const w = await world();
    expect(await deleteRemoteObject(await w.grant('remote.object_delete', w.post.apId))).toEqual({ deleted: true });
    expect((await db().select().from(posts).where(eq(posts.id, w.post.id)))[0]?.deletedAt).toBeInstanceOf(Date);
    expect((await db().select().from(comments).where(eq(comments.id, w.reply.id)))[0]?.deletedAt).toBeNull();
    expect(await ledger()).toMatchObject([
      {
        subjectKind: 'post',
        subjectId: w.post.id,
        subjectApId: w.post.apId,
        reason: 'remote.object_gone',
        details: { cause: 'Tombstone' },
      },
    ]);
    expect(await types()).toEqual(['post.deleted']);

    expect(await deleteRemoteObject(await w.grant('remote.object_delete', w.post.apId))).toEqual({ deleted: false });
    expect(await ledger()).toHaveLength(1);
  });

  test('a comment likewise; an object we do not hold, or one of ours, is left alone', async () => {
    const w = await world();
    expect(await deleteRemoteObject(await w.grant('remote.object_delete', w.other.apId))).toEqual({ deleted: true });
    expect((await ledger()).map((row) => row.subjectKind)).toEqual(['comment']);
    expect(await types()).toEqual(['comment.deleted']);

    expect(await deleteRemoteObject(await w.grant('remote.object_delete', 'https://lemmy.test/post/404'))).toEqual({ deleted: false });
    expect(await deleteRemoteObject(await w.grant('remote.object_delete', w.mine.apId))).toEqual({ deleted: false });
    expect((await db().select().from(posts).where(eq(posts.id, w.mine.id)))[0]?.deletedAt).toBeNull();
    expect(await ledger()).toHaveLength(1);
  });

  test('only the instance importing may delete a remote object', async () => {
    const w = await world();
    const decision = await authorize(
      'remote.object_delete',
      { kind: 'local', actorId: w.carol.id, siteRole: 'user' },
      { apId: w.post.apId },
    );
    expect(decision).toEqual({ ok: false, reason: 'auth.required' });
  });
});
