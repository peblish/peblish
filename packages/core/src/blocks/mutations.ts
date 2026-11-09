import type { Uuid } from '@peblish/schema/ids';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { BlockTarget } from '../authz/actions/blocks.ts';
import { actors } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import type { WriteTx } from '../db/write.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { maxCommunityBlocks, maxInstanceBlocks, maxPersonBlocks } from './limits.ts';
import { communityBlocks, instanceBlocks, personBlocks } from './tables.ts';

// A local person's block list (S02). Nothing is sent to the blocked side. The one thing that
// federates is a side effect of blocking a community or an instance: the person's follows of
// those communities end, and each goes out as Undo(Follow) like unsubscribing does.

const targetIdOf = (target: BlockTarget): Uuid => (target.kind === 'instance' ? target.instanceId : target.actorId);

/** Inserts the row; true when it is new. */
async function insertRow(db: WriteTx, blockerId: Uuid, target: BlockTarget): Promise<boolean> {
  const inserted =
    target.kind === 'person'
      ? await db
          .insert(personBlocks)
          .values({ blockerId, blockedId: target.actorId })
          .onConflictDoNothing()
          .returning({ at: personBlocks.createdAt })
      : target.kind === 'community'
        ? await db
            .insert(communityBlocks)
            .values({ blockerId, communityId: target.actorId })
            .onConflictDoNothing()
            .returning({ at: communityBlocks.createdAt })
        : await db
            .insert(instanceBlocks)
            .values({ blockerId, instanceId: target.instanceId })
            .onConflictDoNothing()
            .returning({ at: instanceBlocks.createdAt });
  return inserted.length > 0;
}

/** How many blocks of the target's kind the blocker has, and the most they may have. */
async function sizeOf(db: WriteTx, blockerId: Uuid, kind: BlockTarget['kind']): Promise<{ size: number; max: number }> {
  const table = kind === 'person' ? personBlocks : kind === 'community' ? communityBlocks : instanceBlocks;
  const [row] = await db.select({ size: count() }).from(table).where(eq(table.blockerId, blockerId));
  return { size: row?.size ?? 0, max: kind === 'person' ? maxPersonBlocks : kind === 'community' ? maxCommunityBlocks : maxInstanceBlocks };
}

/**
 * Blocks a person, a community or an instance. Blocking twice changes nothing and emits
 * nothing. A community block ends the blocker's follow of it, and an instance block their
 * follows of every community there, one `follow.removed` for each. The recheck refuses a
 * blocker site-banned since authorize() (auth.site_banned). Runs inside addBlock, which holds
 * the blocker's actor row.
 */
const addBlockRow = defineMutation({
  action: 'block.add',
  emits: ['block.added', 'follow.removed'],
  recheck: true,
  async run(t, grant, _input: void) {
    const blockerId = grant.actorId;
    const { target } = grant.subject;
    const created = await insertRow(t.db, blockerId, target);
    if (created) {
      const { size, max } = await sizeOf(t.db, blockerId, target.kind);
      if (size > max) throw new Refused('block.add', 'block.limit');
      await t.emit({ type: 'block.added', v: 1, blockerId, kind: target.kind, targetId: targetIdOf(target) });
    }
    if (target.kind === 'person') return { created, unfollowed: 0 };

    const scope =
      target.kind === 'community'
        ? eq(follows.followeeId, target.actorId)
        : inArray(
            follows.followeeId,
            t.db
              .select({ id: actors.id })
              .from(actors)
              .where(and(eq(actors.kind, 'Group'), eq(actors.instanceId, target.instanceId))),
          );
    const ended = await t.db
      .delete(follows)
      .where(and(eq(follows.followerId, blockerId), scope))
      .returning({ id: follows.id, apId: follows.apId, followeeId: follows.followeeId });
    if (ended.length > 0) {
      const places = await t.db
        .select({ id: actors.id, local: actors.local })
        .from(actors)
        .where(
          inArray(
            actors.id,
            ended.map((row) => row.followeeId),
          ),
        );
      const local = new Map(places.map((row) => [row.id, row.local]));
      for (const row of ended) {
        await t.emit({
          type: 'follow.removed',
          v: 1,
          followId: row.id,
          apId: row.apId ?? '',
          followerId: blockerId,
          followeeId: row.followeeId,
          followerLocal: true,
          followeeLocal: local.get(row.followeeId) === true,
          by: 'follower',
        });
      }
    }
    return { created, unfollowed: ended.length };
  },
});

/**
 * block.add in its own transaction (addBlockRow, rechecked). The blocker's actor row is locked
 * FOR NO KEY UPDATE first, before the recheck reads it FOR SHARE: the lock order puts the acting
 * actor first, it serializes one person's concurrent blocks (so the size check cannot be raced
 * past the cap, and two blocks at once do not deadlock upgrading a shared lock), and a site ban,
 * which locks the same row before inserting, either waits for the block or is seen by the recheck.
 */
export const addBlock = defineMutation({
  action: 'block.add',
  emits: ['block.added', 'follow.removed'],
  async run(t, grant, input: void) {
    await t.db.select({ id: actors.id }).from(actors).where(eq(actors.id, grant.actorId)).for('no key update');
    return addBlockRow.within(t, grant, input);
  },
});

/**
 * Lifts a block. A block that is not there is fine: `removed` is false and nothing is emitted.
 * Rechecked like every person's write, so a site-banned person changes nothing (auth.site_banned).
 */
export const removeBlock = defineMutation({
  action: 'block.remove',
  emits: ['block.removed'],
  recheck: true,
  async run(t, grant, _input: void) {
    const blockerId = grant.actorId;
    const { target } = grant.subject;
    const deleted =
      target.kind === 'person'
        ? await t.db
            .delete(personBlocks)
            .where(and(eq(personBlocks.blockerId, blockerId), eq(personBlocks.blockedId, target.actorId)))
            .returning({ at: personBlocks.createdAt })
        : target.kind === 'community'
          ? await t.db
              .delete(communityBlocks)
              .where(and(eq(communityBlocks.blockerId, blockerId), eq(communityBlocks.communityId, target.actorId)))
              .returning({ at: communityBlocks.createdAt })
          : await t.db
              .delete(instanceBlocks)
              .where(and(eq(instanceBlocks.blockerId, blockerId), eq(instanceBlocks.instanceId, target.instanceId)))
              .returning({ at: instanceBlocks.createdAt });
    if (deleted.length === 0) return { removed: false };
    await t.emit({ type: 'block.removed', v: 1, blockerId, kind: target.kind, targetId: targetIdOf(target) });
    return { removed: true };
  },
});
