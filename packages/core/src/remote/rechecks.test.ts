import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { comments, posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { outboxEvents, seedComment, seedPost } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { deleteRemoteObject } from './objects.ts';
import { claimRechecks, rechecks } from './rechecks.ts';
import { objectRechecks } from './tables.ts';

const now = new Date('2026-11-09T12:00:00Z');
const hours = (n: number) => new Date(now.getTime() + n * 60 * 60 * 1000);
const day = rechecks.everyMs / (60 * 60 * 1000);

beforeEach(truncateAll);

async function claim(at: Date, limit: number = rechecks.perRun) {
  const decision = await authorize('remote.object_recheck', await systemPrincipal(db(), 'scheduled'), {});
  if (!decision.ok) throw new Error(decision.reason);
  return claimRechecks(decision.grant, { now: at, limit });
}

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
  return { post, reply, fresh, gone, mine, claim, importer: local.importer };
}

/** Another server's posts and comments, stored in the order they are made (ids and creation times agree). */
async function otherServer() {
  const peer = await seedInstance('other.test', false);
  const community = await seedActor(peer, 'Group', 'other', { apId: 'https://other.test/c/other' });
  const carol = await seedActor(peer, 'Person', 'carol', { apId: 'https://other.test/u/carol' });
  return {
    post: (name: string, hoursFromNow: number) =>
      seedPost(peer, community, carol, { apId: `https://other.test/post/${name}`, createdAt: hours(hoursFromNow) }),
    comment: (post: Awaited<ReturnType<typeof seedPost>>, name: string, hoursFromNow: number) =>
      seedComment(peer, post, carol, { apId: `https://other.test/comment/${name}`, createdAt: hours(hoursFromNow) }),
  };
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

  test('a long backlog drains oldest first across runs, each object once, however small the limit', async () => {
    await seedLocalInstance('rem.test');
    const peers = await otherServer();
    // Stored in this order, as ids and creation times both say.
    const first = await peers.post('p0', -100);
    const backlog = [first.apId];
    for (let i = 1; i < 7; i++) backlog.push((await peers.post(`p${i}`, -100 + i)).apId);
    for (let i = 0; i < 3; i++) backlog.push((await peers.comment(first, `c${i}`, -90 + i)).apId);
    const seen: string[] = [];
    for (let run = 0; run < 4; run++) seen.push(...(await claim(now, 3)).map((object) => object.apId));
    expect(seen).toEqual(backlog);
    expect(await claim(now, 3)).toEqual([]);
    // And a day on, they come round again: stalest mark first, in turn.
    expect((await claim(hours(day + 1), 4)).map((object) => object.apId)).toEqual(seen.slice(0, 4));
  });

  test('stale marks and never-asked objects are taken together, by age', async () => {
    const w = await world();
    expect((await w.claim(now, 1)).map((object) => object.apId)).toEqual([w.post.apId]);
    expect((await w.claim(hours(2), 1)).map((object) => object.apId)).toEqual([w.reply.apId]);
    // A day later both marks are stale; an object stored since (due then too) comes between them.
    const peers = await otherServer();
    const late = await peers.post('late', 1);
    expect((await w.claim(hours(day + 3), 5)).map((object) => object.apId)).toEqual([w.fresh.apId, w.post.apId, late.apId, w.reply.apId]);
  });

  test('the mark goes with a deleted object: when its server says it is gone, and when any other path deleted it', async () => {
    const w = await world();
    await w.claim(now);
    expect(await db().select().from(objectRechecks)).toHaveLength(2);

    const decision = await authorize('remote.object_delete', await w.importer(), { apId: w.reply.apId });
    if (!decision.ok) throw new Error(decision.reason);
    expect(await deleteRemoteObject(decision.grant)).toEqual({ deleted: true });
    expect((await db().select().from(objectRechecks)).map((row) => row.objectId)).toEqual([w.post.id]);

    // Deleted by the author instead: the mark is dropped the next time the claim comes to it.
    await writer().update(posts).set({ deletedAt: now }).where(eq(posts.id, w.post.id));
    expect((await w.claim(hours(day + 1))).map((object) => object.apId)).toEqual([w.fresh.apId]);
    expect((await db().select().from(objectRechecks)).map((row) => row.objectId)).toEqual([w.fresh.id]);
  });
});
