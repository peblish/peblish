import { eq, sql } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { outbox } from '../db/tables/outbox.ts';
import { createPost } from '../posts/create.ts';
import { truncateAll } from '../testing/db.ts';
import { postWithFault } from '../testing/fault-mutation.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { Refused } from './refused.ts';
import { tx } from './tx.ts';

// The time-of-check gap: a grant is issued, then its subject is invalidated before the write.
// A mutation with recheck: true re-runs the policy inside its transaction and refuses.

beforeEach(truncateAll);

async function staleGrant() {
  const instance = await seedInstance('feddit.test');
  const author = await seedActor(instance, 'Person', 'Andrew');
  const community = await seedActor(instance, 'Group', 'announcements');
  const decision = await authorize('post.create', localUser(author.id), { communityId: community.id });
  if (!decision.ok) throw new Error(decision.reason);
  // No ban table exists yet (lane AZ, MODF); deleting the community invalidates the subject.
  await tx(async (t) => {
    await t.db.update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, community.id));
  });
  return decision.grant;
}

const counts = async () => {
  const [row] = await db().execute<{ posts: number; outbox: number }>(
    sql`select (select count(*) from ${posts})::int as posts, (select count(*) from ${outbox})::int as outbox`,
  );
  return row;
};

test('a recheck mutation refuses a stale grant with the exact reason and writes nothing', async () => {
  const grant = await staleGrant();
  const attempt = createPost(grant, { title: 'Too late' });
  await expect(attempt).rejects.toBeInstanceOf(Refused);
  await expect(attempt).rejects.toMatchObject({ action: 'post.create', reason: 'target.deleted' });
  expect(await counts()).toEqual({ posts: 0, outbox: 0 });
});

test('control: without recheck the same stale grant would have written', async () => {
  const grant = await staleGrant();
  await postWithFault(async () => {})(grant, { id: '0192f5a0-0000-7000-8000-00000000c001' });
  expect(await counts()).toEqual({ posts: 1, outbox: 1 });
});
