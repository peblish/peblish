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

  test('ap_id, local and instance_id are immutable', async () => {
    const local = await seedInstance('feddit.test');
    const actor = await seedActor(local, 'Person', 'Andrew');
    for (const change of [{ apId: 'https://elsewhere.test/u/Andrew' }, { local: false }]) {
      expect(await failure(writer().update(actors).set(change).where(eq(actors.id, actor.id)))).toMatchObject({ code: '23000' });
    }
    await writer().update(actors).set({ displayName: 'Andrew T' }).where(eq(actors.id, actor.id));
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

  test('the modlog and the deletion ledger are append-only', async () => {
    await writer()
      .insert(modlog)
      .values({ action: 'post.remove', authority: { kind: 'site-admin' } });
    await writer()
      .insert(deletionLedger)
      .values({ subjectKind: 'post', subjectId: '0192f5a0-0000-7000-8000-000000000001', reason: 'test' });
    expect(await failure(writer().delete(modlog))).toMatchObject({ code: '23000' });
    expect(await failure(writer().update(deletionLedger).set({ reason: 'changed' }))).toMatchObject({ code: '23000' });
  });

  test('the read pool cannot write', async () => {
    expect(await failure(db().insert(modlog).values({ action: 'x', authority: {} }))).toMatchObject({ code: '25006' });
    expect(await db().execute(sql`select 1 as one`)).toEqual([{ one: 1 }]);
  });
});
