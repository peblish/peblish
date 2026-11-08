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
      .values({ action: 'mod.remove', authority: { kind: 'site-admin' } });
    await writer()
      .insert(deletionLedger)
      .values({ subjectKind: 'post', subjectId: '0192f5a0-0000-7000-8000-000000000001', reason: 'test' });
    for (const statement of [
      writer().update(modlog).set({ reason: 'changed' }),
      writer().delete(modlog),
      writer().execute(sql`truncate modlog`),
      writer().update(deletionLedger).set({ reason: 'changed' }),
      writer().delete(deletionLedger),
      writer().execute(sql`truncate deletion_ledger`),
    ]) {
      expect(await failure(statement)).toMatchObject({ code: '23000' });
    }
  });

  test('the modlog outlives purged content: references go null, ap_ids stay', async () => {
    const local = await seedInstance('feddit.test');
    const moderator = await seedActor(local, 'Person', 'Andrew');
    const community = await seedActor(local, 'Group', 'announcements');
    const [post] = await writer()
      .insert(posts)
      .values({
        apId: 'https://feddit.test/ap/post/9',
        local: true,
        instanceId: local.id,
        authorId: moderator.id,
        communityId: community.id,
        title: 't',
        publishedAt: new Date(),
      })
      .returning();
    await writer()
      .insert(modlog)
      .values({
        action: 'mod.remove',
        actorId: moderator.id,
        actorApId: moderator.apId,
        communityId: community.id,
        targetPostId: post!.id,
        targetApId: post!.apId,
        authority: { kind: 'site-admin', actorId: moderator.id },
      });
    await writer().delete(posts).where(eq(posts.id, post!.id));
    const [entry] = await db().select().from(modlog);
    expect(entry).toMatchObject({ targetPostId: null, targetApId: post!.apId, actorId: moderator.id, communityId: community.id });
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
    expect(await failure(db().insert(modlog).values({ action: 'x', authority: {} }))).toMatchObject({ code: '25006' });
    expect(await db().execute(sql`select 1 as one`)).toEqual([{ one: 1 }]);
  });
});
