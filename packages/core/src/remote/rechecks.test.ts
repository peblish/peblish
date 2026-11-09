import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { comments, posts } from '../db/tables/content.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { outboxEvents, seedComment, seedPost } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { claimRechecks, rechecks } from './rechecks.ts';
import { objectRechecks } from './tables.ts';

const now = new Date('2026-11-09T12:00:00Z');
const hours = (n: number) => new Date(now.getTime() + n * 60 * 60 * 1000);
const day = rechecks.everyMs / (60 * 60 * 1000);

beforeEach(truncateAll);

async function world() {
  const local = await seedLocalInstance('rem.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const community = await seedActor(lemmy, 'Group', 'lab', { apId: 'https://lemmy.test/c/lab' });
  const bob = await seedActor(lemmy, 'Person', 'bob', { apId: 'https://lemmy.test/u/bob' });
  const stored = (hoursAgo: number) => ({ createdAt: hours(-hoursAgo) });
  const post = await seedPost(lemmy, community, bob, { apId: 'https://lemmy.test/post/1', ...stored(30) });
  const reply = await seedComment(lemmy, post, bob, { apId: 'https://lemmy.test/comment/1', ...stored(26) });
  const fresh = await seedComment(lemmy, post, bob, { apId: 'https://lemmy.test/comment/2', ...stored(2) });
  const gone = await seedComment(lemmy, post, bob, { apId: 'https://lemmy.test/comment/3', ...stored(40), deletedAt: hours(-3) });
  const mine = await seedPost(local.instance, community, bob, { apId: 'https://rem.test/post/9', ...stored(50) });
  const claim = async (at: Date, limit: number = rechecks.perRun) => {
    const decision = await authorize('remote.object_recheck', await systemPrincipal(db(), 'scheduled'), {});
    if (!decision.ok) throw new Error(decision.reason);
    return claimRechecks(decision.grant, { now: at, limit });
  };
  return { post, reply, fresh, gone, mine, claim };
}

describe('the remote objects due to be asked after', () => {
  test('are the held remote ones stored more than a day ago, oldest first, not deleted ones and not our own', async () => {
    const w = await world();
    expect((await w.claim(now)).map((object) => [object.kind, object.apId])).toEqual([
      ['post', w.post.apId],
      ['comment', w.reply.apId],
    ]);
    expect(await db().select().from(objectRechecks)).toHaveLength(2);
    expect((await outboxEvents()).filter((event) => (event as { type: string }).type === 'remote.rechecked')).toMatchObject([
      { objects: 2 },
    ]);
  });

  test('are taken once a day: marked when taken, due again a day later, and the limit leaves the rest for the next run', async () => {
    const w = await world();
    expect(await w.claim(now, 1)).toMatchObject([{ apId: w.post.apId }]);
    expect(await w.claim(now, 5)).toMatchObject([{ apId: w.reply.apId }]);
    expect(await w.claim(now)).toEqual([]);
    expect(await w.claim(hours(day - 1))).toMatchObject([{ apId: w.fresh.apId }]);
    // Later still, everything stored comes round again, oldest first.
    expect((await w.claim(hours(day + 3))).map((object) => object.apId)).toEqual([w.post.apId, w.reply.apId]);
    expect((await db().select().from(posts).where(eq(posts.id, w.mine.id)))[0]?.deletedAt).toBeNull();
    expect(await db().select().from(comments).where(eq(comments.id, w.gone.id))).toHaveLength(1);
  });

  test('two workers at once take different objects', async () => {
    const w = await world();
    const [a, b] = await Promise.all([w.claim(now), w.claim(now)]);
    expect([...a, ...b].map((object) => object.apId).sort()).toEqual([w.post.apId, w.reply.apId].sort());
  });
});
