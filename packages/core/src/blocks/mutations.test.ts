import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { siteBans } from '../bans/tables.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { admin, gate, outboxEvents } from '../testing/seed-az.ts';
import { seedFollow } from '../testing/seed-c1.ts';
import { seedPerson, person } from '../testing/seed-f.ts';
import { addBlockAs, removeBlockAs } from './actions.ts';
import { maxPersonBlocks } from './limits.ts';
import { communityBlocks, instanceBlocks, personBlocks } from './tables.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const piefed = await seedInstance('piefed.test', false);
  const alice = await seedPerson(local, 'alice');
  return {
    local,
    lemmy,
    piefed,
    alice,
    me: person(alice.id),
    bob: await seedActor(local, 'Person', 'bob'),
    boss: await seedPerson(local, 'boss', { admin: true }),
    remoteBob: await seedActor(lemmy, 'Person', 'bob'),
    deleted: await seedActor(lemmy, 'Person', 'gone', { deletedAt: new Date() }),
    instanceActor: await seedActor(local, 'Application', 'feddit.test'),
    news: await seedActor(local, 'Group', 'news'),
    tech: await seedActor(lemmy, 'Group', 'tech'),
    lab: await seedActor(lemmy, 'Group', 'lab'),
    pie: await seedActor(piefed, 'Group', 'pie'),
    removed: await seedActor(lemmy, 'Group', 'removed', { deletedAt: new Date() }),
  };
}

const types = async () => (await outboxEvents()).map((event) => (event as { type: string }).type);
const blockEvents = async () => (await outboxEvents()).filter((event) => (event as { type: string }).type.startsWith('block.'));

describe('block.add and block.remove: who may, exact reasons', () => {
  test('refusals', async () => {
    const w = await world();
    const person_ = (actorId: string) => ({ kind: 'person' as const, actorId });
    const community = (actorId: string) => ({ kind: 'community' as const, actorId });
    const missing = '019aaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

    expect(await addBlockAs({ kind: 'anonymous' }, person_(w.bob.id))).toEqual({ ok: false, reason: 'auth.required' });
    expect(await addBlockAs({ kind: 'remote', actorId: w.remoteBob.id, announcedBy: null }, person_(w.bob.id))).toEqual({
      ok: false,
      reason: 'auth.required',
    });
    expect(await removeBlockAs({ kind: 'anonymous' }, person_(w.bob.id))).toEqual({ ok: false, reason: 'auth.required' });

    expect(await addBlockAs(w.me, person_(missing))).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await addBlockAs(w.me, person_(w.news.id))).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await addBlockAs(w.me, person_(w.deleted.id))).toEqual({ ok: false, reason: 'target.deleted' });
    expect(await addBlockAs(w.me, person_(w.alice.id))).toEqual({ ok: false, reason: 'target.protected' });
    expect(await addBlockAs(w.me, person_(w.instanceActor.id))).toEqual({ ok: false, reason: 'target.protected' });
    expect(await addBlockAs(w.me, person_(w.boss.id))).toEqual({ ok: false, reason: 'target.protected' });

    expect(await addBlockAs(w.me, community(missing))).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await addBlockAs(w.me, community(w.bob.id))).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await addBlockAs(w.me, community(w.removed.id))).toEqual({ ok: false, reason: 'community.deleted' });

    expect(await addBlockAs(w.me, { kind: 'instance', instanceId: missing })).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await addBlockAs(w.me, { kind: 'instance', instanceId: w.local.id })).toEqual({ ok: false, reason: 'block.own_instance' });

    expect(await blockEvents()).toEqual([]);
  });

  test('an admin may block people, and a person may be blocked by anyone not themselves', async () => {
    const w = await world();
    expect(await addBlockAs(admin(w.boss.id), { kind: 'person', actorId: w.bob.id })).toMatchObject({ ok: true, created: true });
    expect(await addBlockAs(w.me, { kind: 'person', actorId: w.remoteBob.id })).toMatchObject({ ok: true, created: true });
  });
});

describe('block.add', () => {
  test('adding twice makes one row and one event; removing is idempotent too', async () => {
    const w = await world();
    const target = { kind: 'person' as const, actorId: w.bob.id };
    expect(await addBlockAs(w.me, target)).toEqual({ ok: true, created: true, unfollowed: 0 });
    expect(await addBlockAs(w.me, target)).toEqual({ ok: true, created: false, unfollowed: 0 });
    expect(await writer().select().from(personBlocks)).toHaveLength(1);
    expect(await blockEvents()).toEqual([{ type: 'block.added', v: 1, blockerId: w.alice.id, kind: 'person', targetId: w.bob.id }]);

    expect(await removeBlockAs(w.me, target)).toEqual({ ok: true, removed: true });
    expect(await removeBlockAs(w.me, target)).toEqual({ ok: true, removed: false });
    expect(await writer().select().from(personBlocks)).toHaveLength(0);
    expect((await blockEvents()).map((event) => (event as { type: string }).type)).toEqual(['block.added', 'block.removed']);
  });

  test('a person block ends no follow and emits only block.added', async () => {
    const w = await world();
    await seedFollow(w.alice, w.tech);
    await addBlockAs(w.me, { kind: 'person', actorId: w.remoteBob.id });
    expect(await writer().select().from(follows)).toHaveLength(1);
    expect(await types()).toEqual(['block.added']);
  });

  test('a community block deletes the follow and emits follow.removed, in one transaction', async () => {
    const w = await world();
    await seedFollow(w.alice, w.tech);
    await seedFollow(w.alice, w.lab);
    await seedFollow(w.alice, w.news);
    expect(await addBlockAs(w.me, { kind: 'community', actorId: w.tech.id })).toEqual({ ok: true, created: true, unfollowed: 1 });
    const left = await writer().select({ followee: follows.followeeId }).from(follows);
    expect(left.map((row) => row.followee).sort()).toEqual([w.lab.id, w.news.id].sort());
    expect(await types()).toEqual(['block.added', 'follow.removed']);
    expect((await outboxEvents()).at(-1)).toMatchObject({
      type: 'follow.removed',
      followerId: w.alice.id,
      followeeId: w.tech.id,
      followerLocal: true,
      followeeLocal: false,
      by: 'follower',
    });
    // The block and the unfollow were committed together: both outbox rows share a transaction.
    const same = await writer().execute<{ n: number }>(sql`select count(distinct tx_id::text)::int as n from outbox`);
    expect(same[0]?.n).toBe(1);
  });

  test('an instance block ends the follows of that instance only', async () => {
    const w = await world();
    await seedFollow(w.alice, w.tech);
    await seedFollow(w.alice, w.lab, 'pending');
    await seedFollow(w.alice, w.pie);
    await seedFollow(w.alice, w.news);
    expect(await addBlockAs(w.me, { kind: 'instance', instanceId: w.lemmy.id })).toEqual({ ok: true, created: true, unfollowed: 2 });
    const left = await writer().select({ followee: follows.followeeId }).from(follows);
    expect(left.map((row) => row.followee).sort()).toEqual([w.pie.id, w.news.id].sort());
    expect(await types()).toEqual(['block.added', 'follow.removed', 'follow.removed']);
    expect(await writer().select().from(instanceBlocks)).toHaveLength(1);
  });

  test('another person keeps their follows and has no block rows', async () => {
    const w = await world();
    const carol = await seedPerson(w.local, 'carol');
    await seedFollow(carol, w.tech);
    await addBlockAs(w.me, { kind: 'community', actorId: w.tech.id });
    expect(await writer().select().from(follows).where(eq(follows.followerId, carol.id))).toHaveLength(1);
    expect(await writer().select().from(communityBlocks).where(eq(communityBlocks.blockerId, carol.id))).toHaveLength(0);
  });

  test('the list has a cap, and a block already there is not refused at it', async () => {
    const w = await world();
    const rows = Array.from({ length: maxPersonBlocks }, (_, n) => ({
      apId: `https://lemmy.test/ap/u.p${n}`,
      kind: 'Person' as const,
      local: false,
      instanceId: w.lemmy.id,
      name: `p${n}`,
    }));
    const people = await writer().insert(actors).values(rows).returning({ id: actors.id });
    await writer()
      .insert(personBlocks)
      .values(people.map((row) => ({ blockerId: w.alice.id, blockedId: row.id })));
    expect(await addBlockAs(w.me, { kind: 'person', actorId: w.bob.id })).toEqual({ ok: false, reason: 'block.limit' });
    expect(await writer().select().from(personBlocks)).toHaveLength(maxPersonBlocks);
    expect(await blockEvents()).toEqual([]);
    expect(await addBlockAs(w.me, { kind: 'person', actorId: people[0]!.id })).toMatchObject({ ok: true, created: false });
  });
});

/** How many backends in this database wait on a lock. */
async function lockWaiters() {
  const [row] = await db().execute<{ n: number }>(
    sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return row?.n ?? 0;
}

describe('a site-banned person cannot block or unblock', () => {
  test('a ban that lands while the block waits for the blocker row refuses it', async () => {
    const w = await world();
    // The ban holds alice's row as bans/site.ts does and commits once the block waits on it.
    const commit = gate();
    const ban = writer().transaction(async (t) => {
      await t.select({ id: actors.id }).from(actors).where(eq(actors.id, w.alice.id)).for('no key update');
      await t.insert(siteBans).values({ actorId: w.alice.id, source: 'local' });
      await commit.opened;
    });
    const block = addBlockAs(w.me, { kind: 'community', actorId: w.news.id });
    await expect.poll(lockWaiters).toBe(1);
    commit.open();
    await ban;
    expect(await block).toEqual({ ok: false, reason: 'auth.site_banned' });
    expect(await writer().select().from(communityBlocks)).toEqual([]);
    expect(await types()).toEqual([]);
  });

  test('removing a block is refused too, and the block stays', async () => {
    const w = await world();
    await addBlockAs(w.me, { kind: 'person', actorId: w.bob.id });
    await writer().insert(siteBans).values({ actorId: w.alice.id, source: 'local' });
    expect(await removeBlockAs(w.me, { kind: 'person', actorId: w.bob.id })).toEqual({ ok: false, reason: 'auth.site_banned' });
    expect(await addBlockAs(w.me, { kind: 'person', actorId: w.remoteBob.id })).toEqual({ ok: false, reason: 'auth.site_banned' });
    expect(await writer().select().from(personBlocks)).toHaveLength(1);
  });

  test('two blocks at once both apply, without a deadlock', async () => {
    const w = await world();
    // A third transaction holds alice's row FOR SHARE (as any recheck does) until both blocks wait on it.
    const release = gate();
    const holder = writer().transaction(async (t) => {
      await t.select({ id: actors.id }).from(actors).where(eq(actors.id, w.alice.id)).for('share');
      await release.opened;
    });
    const both = Promise.all([
      addBlockAs(w.me, { kind: 'person', actorId: w.bob.id }),
      addBlockAs(w.me, { kind: 'person', actorId: w.remoteBob.id }),
    ]);
    await expect.poll(lockWaiters).toBe(2);
    release.open();
    await holder;
    expect(await both).toEqual([
      { ok: true, created: true, unfollowed: 0 },
      { ok: true, created: true, unfollowed: 0 },
    ]);
  });
});
