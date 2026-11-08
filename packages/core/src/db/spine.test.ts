import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { beforeEach, describe, expect, test } from 'vitest';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { truncateAll } from '../testing/db.ts';
import { db } from './read.ts';
import { actors } from './tables/actors.ts';
import { comments, posts, votes } from './tables/content.ts';
import { modlog } from './tables/moderation.ts';
import { deletionLedger } from './tables/site.ts';
import { writer } from './write.ts';

/** The Postgres error a statement fails with (Drizzle wraps it as the cause), for exact assertions. */
async function failure(statement: Promise<unknown>) {
  try {
    await statement;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof postgres.PostgresError) return { code: cause.code, constraint: cause.constraint_name };
    throw error;
  }
  throw new Error('statement succeeded');
}

beforeEach(truncateAll);

describe('migration 0001 identity spine', () => {
  test('new local actor names match [A-Za-z0-9_]; imported and remote ones keep theirs', async () => {
    const local = await seedInstance('feddit.test');
    const remote = await seedInstance('lemmy.test', false);
    expect(await failure(seedActor(local, 'Person', 'feddit-admin'))).toMatchObject({ constraint: 'actors_local_name_chars' });
    await seedActor(local, 'Person', 'feddit-admin', { importedAt: new Date(), apId: 'https://feddit.test/u/feddit-admin' });
    await seedActor(remote, 'Person', 'some.one-else');
  });

  test('local names are unique across Person and Group, case-insensitively', async () => {
    const local = await seedInstance('feddit.test');
    await seedActor(local, 'Person', 'Andrew');
    expect(await failure(seedActor(local, 'Group', 'andrew'))).toMatchObject({ constraint: 'actors_local_name_unique' });
    // Remote servers may reuse a name across kinds (Lemmy does).
    const remote = await seedInstance('lemmy.test', false);
    await seedActor(remote, 'Person', 'news');
    await seedActor(remote, 'Group', 'news');
  });

  test('ap_id, local and instance_id are immutable on actors, posts, comments and votes', async () => {
    const local = await seedInstance('feddit.test');
    const remote = await seedInstance('lemmy.test', false);
    const author = await seedActor(local, 'Person', 'Andrew');
    const community = await seedActor(local, 'Group', 'announcements');
    const spine = { local: true, instanceId: local.id };
    const [post] = await writer()
      .insert(posts)
      .values({
        ...spine,
        apId: 'https://feddit.test/ap/post/1',
        authorId: author.id,
        communityId: community.id,
        title: 't',
        publishedAt: new Date(),
      })
      .returning();
    const [comment] = await writer()
      .insert(comments)
      .values({
        ...spine,
        apId: 'https://feddit.test/ap/comment/1',
        postId: post!.id,
        authorId: author.id,
        path: 'c1',
        publishedAt: new Date(),
      })
      .returning();
    const [vote] = await writer()
      .insert(votes)
      .values({ ...spine, apId: 'https://feddit.test/ap/activity/v1', voterId: author.id, postId: post!.id, value: 1 })
      .returning();
    const changes = [{ apId: 'https://elsewhere.test/x' }, { local: false }, { instanceId: remote.id }];
    const rows = [
      [actors, author.id],
      [posts, post!.id],
      [comments, comment!.id],
      [votes, vote!.id],
    ] as const;
    for (const [table, rowId] of rows) {
      for (const change of changes) {
        expect(await failure(writer().update(table).set(change).where(eq(table.id, rowId)))).toMatchObject({ code: '23000' });
      }
    }
    await writer().update(actors).set({ displayName: 'Andrew T' }).where(eq(actors.id, author.id));
  });

  test('comment paths stop at depth 50 and votes have exactly one target', async () => {
    const local = await seedInstance('feddit.test');
    const author = await seedActor(local, 'Person', 'Andrew');
    const community = await seedActor(local, 'Group', 'announcements');
    const [post] = await writer()
      .insert(posts)
      .values({
        apId: 'https://feddit.test/ap/post/1',
        local: true,
        instanceId: local.id,
        authorId: author.id,
        communityId: community.id,
        title: 't',
        publishedAt: new Date(),
      })
      .returning();
    const comment = (depth: number) => ({
      apId: `https://feddit.test/ap/comment/${depth}`,
      local: true,
      instanceId: local.id,
      postId: post!.id,
      authorId: author.id,
      path: Array.from({ length: depth }, (_, index) => `c${index}`).join('.'),
      publishedAt: new Date(),
    });
    await writer().insert(comments).values(comment(50));
    expect(await failure(writer().insert(comments).values(comment(51)))).toMatchObject({ constraint: 'comments_depth' });
    expect(
      await failure(
        writer()
          .insert(votes)
          .values({ apId: 'https://feddit.test/ap/activity/v', local: true, instanceId: local.id, voterId: author.id, value: 1 }),
      ),
    ).toMatchObject({ constraint: 'votes_one_target' });
  });

  test('the modlog and the deletion ledger refuse update, delete and truncate', async () => {
    await writer()
      .insert(modlog)
      .values({ action: 'mod.remove', actorApId: 'https://feddit.test/u/Andrew', authority: { kind: 'site-admin' } });
    await writer()
      .insert(deletionLedger)
      .values({ subjectKind: 'post', subjectId: '0192f5a0-0000-7000-8000-000000000001', reason: 'test' });
    for (const statement of [
      writer().update(modlog).set({ reason: 'changed' }),
      // modlog.public came in 0002; the trigger compares every column but the references.
      writer().update(modlog).set({ public: false }),
      writer().delete(modlog),
      writer().execute(sql`truncate modlog`),
      writer().update(deletionLedger).set({ reason: 'changed' }),
      writer().delete(deletionLedger),
      writer().execute(sql`truncate deletion_ledger`),
    ]) {
      expect(await failure(statement)).toMatchObject({ code: '23000' });
    }
  });

  describe('the modlog outlives purges and refuses tampering', () => {
    async function logged() {
      const local = await seedInstance('feddit.test');
      const moderator = await seedActor(local, 'Person', 'Andrew');
      const target = await seedActor(local, 'Person', 'troll');
      const community = await seedActor(local, 'Group', 'announcements');
      const otherActor = await seedActor(local, 'Person', 'bystander');
      const otherCommunity = await seedActor(local, 'Group', 'elsewhere');
      const [post] = await writer()
        .insert(posts)
        .values({
          apId: 'https://feddit.test/ap/post/9',
          local: true,
          instanceId: local.id,
          authorId: target.id,
          communityId: community.id,
          title: 't',
          publishedAt: new Date(),
        })
        .returning();
      const [comment] = await writer()
        .insert(comments)
        .values({
          apId: 'https://feddit.test/ap/comment/9',
          local: true,
          instanceId: local.id,
          postId: post!.id,
          authorId: target.id,
          path: 'c9',
          publishedAt: new Date(),
        })
        .returning();
      const entry = (values: Partial<typeof modlog.$inferInsert>) =>
        writer()
          .insert(modlog)
          .values({
            action: 'mod.remove',
            actorId: moderator.id,
            actorApId: moderator.apId,
            communityId: community.id,
            communityApId: community.apId,
            authority: { kind: 'site-admin', actorId: moderator.id },
            ...values,
          })
          .returning()
          .then(([row]) => row!);
      return { moderator, target, community, otherActor, otherCommunity, post: post!, comment: comment!, entry };
    }
    const reread = async (id: string) => (await db().select().from(modlog).where(eq(modlog.id, id)))[0];

    test('a purge nulls the reference and keeps the ap_id: post, comment, actor, community', async () => {
      const { moderator, target, community, post, comment, entry } = await logged();
      const onPost = await entry({ targetPostId: post.id, targetApId: post.apId });
      const onComment = await entry({ targetCommentId: comment.id, targetApId: comment.apId });
      const onActor = await entry({ targetActorId: target.id, targetApId: target.apId });

      await writer().delete(comments).where(eq(comments.id, comment.id));
      expect(await reread(onComment.id)).toMatchObject({ targetCommentId: null, targetApId: comment.apId });
      await writer().delete(posts).where(eq(posts.id, post.id));
      expect(await reread(onPost.id)).toMatchObject({ targetPostId: null, targetApId: post.apId });
      await writer().delete(actors).where(eq(actors.id, target.id));
      expect(await reread(onActor.id)).toMatchObject({ targetActorId: null, targetApId: target.apId });
      await writer().delete(actors).where(eq(actors.id, moderator.id));
      await writer().delete(actors).where(eq(actors.id, community.id));
      for (const { id } of [onPost, onComment, onActor]) {
        expect(await reread(id)).toMatchObject({
          actorId: null,
          actorApId: moderator.apId,
          communityId: null,
          communityApId: community.apId,
        });
      }
    });

    test('re-pointing a reference, or nulling one whose row still exists, is refused', async () => {
      const { target, otherActor, otherCommunity, entry } = await logged();
      const row = await entry({ targetActorId: target.id, targetApId: target.apId });
      for (const change of [
        { communityId: otherCommunity.id },
        { actorId: otherActor.id },
        { targetActorId: otherActor.id },
        { communityId: null },
        { actorId: null },
        { targetActorId: null },
      ]) {
        expect(await failure(writer().update(modlog).set(change).where(eq(modlog.id, row.id)))).toMatchObject({ code: '23000' });
      }
      expect(await reread(row.id)).toMatchObject({ communityId: row.communityId, actorId: row.actorId, targetActorId: target.id });
    });

    test('every set reference needs its ap_id', async () => {
      const { target, entry } = await logged();
      expect(await failure(entry({ communityApId: null }))).toMatchObject({ constraint: 'modlog_community_ap_id' });
      expect(await failure(entry({ targetActorId: target.id }))).toMatchObject({ constraint: 'modlog_target_ap_id' });
      expect(
        await failure(
          writer()
            .insert(modlog)
            .values({ action: 'mod.remove', actorApId: sql`null`, authority: { kind: 'site-admin' } }),
        ),
      ).toMatchObject({ code: '23502' });
    });
  });

  test('every guard trigger is installed', async () => {
    const triggers = await db().execute<{ name: string }>(
      sql`select tgname as name from pg_trigger where not tgisinternal order by tgname`,
    );
    expect(triggers.map(({ name }) => name)).toEqual([
      'actors_immutable_identity',
      'comments_immutable_identity',
      'deletion_ledger_append_only',
      'deletion_ledger_no_truncate',
      'modlog_append_only',
      'modlog_no_truncate',
      'posts_immutable_identity',
      'votes_immutable_identity',
    ]);
  });

  test('the read pool cannot write', async () => {
    expect(await failure(db().insert(modlog).values({ action: 'x', actorApId: 'https://x.test/u/x', authority: {} }))).toMatchObject({
      code: '25006',
    });
    expect(await db().execute(sql`select 1 as one`)).toEqual([{ one: 1 }]);
  });
});
