import type { Uuid } from '@peblish/schema/ids';
import { and, eq, gt, gte, lt, lte, max, sql } from 'drizzle-orm';
import type { WriteTx } from '../db/write.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { shownPins } from './shown.ts';
import { communityPins } from './tables.ts';

// A person's sidebar pins (branch 5), owner-only and never sent anywhere. Every write takes a
// transaction advisory lock of the owner's own before its recheck, so one owner's pins, unpins
// and moves take turns and the positions stay dense; another owner's never wait on them. The
// advisory lock comes first because the recheck's principal refresh reads the owner's actor row
// FOR SHARE: locking that row more strongly afterwards would deadlock two racing moves.
//
// Two orders: the stored one (`position`, every pin of the owner, events carry it) and the shown
// one (only pins of communities the owner still follows and that are open, as the sidebar lists
// them; what the entry points take and answer). A pin outlives an unfollow, so the two differ.

const ownerLock = (db: WriteTx, ownerId: Uuid) =>
  db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`peblish.pins:${ownerId}`}, 0))`);

/** The shown place of the pin stored at `position`: how many shown pins come before it. */
async function shownPlace(db: WriteTx, ownerId: Uuid, position: number): Promise<number> {
  return (await shownPins(db, ownerId)).filter((pin) => pin.shown && pin.position < position).length;
}

const pinRow = defineMutation({
  action: 'pin.add',
  emits: ['pin.added'],
  recheck: true,
  async run(t, grant, _input: void) {
    const ownerId = grant.actorId;
    const { communityId } = grant.subject;
    const [existing] = await t.db
      .select({ position: communityPins.position })
      .from(communityPins)
      .where(and(eq(communityPins.ownerId, ownerId), eq(communityPins.communityId, communityId)));
    if (existing) return { position: await shownPlace(t.db, ownerId, existing.position) };
    // After the last one; max rather than count, so a gap a purged community left takes no one's place.
    const [last] = await t.db
      .select({ position: max(communityPins.position) })
      .from(communityPins)
      .where(eq(communityPins.ownerId, ownerId));
    const position = last?.position === null || last?.position === undefined ? 0 : last.position + 1;
    await t.db.insert(communityPins).values({ ownerId, communityId, position });
    await t.emit({ type: 'pin.added', v: 1, ownerId, communityId, position });
    return { position: await shownPlace(t.db, ownerId, position) };
  },
});

/** Pins a community at the end of the owner's order; a pinned one stays where it is and nothing is emitted. */
export const addPin = defineMutation({
  action: 'pin.add',
  emits: ['pin.added'],
  recheck: 'inner',
  async run(t, grant, input: void) {
    await ownerLock(t.db, grant.actorId);
    return pinRow.within(t, grant, input);
  },
});

const unpinRow = defineMutation({
  action: 'pin.remove',
  emits: ['pin.removed'],
  recheck: true,
  async run(t, grant, _input: void) {
    const ownerId = grant.actorId;
    const { communityId } = grant.subject;
    const [removed] = await t.db
      .delete(communityPins)
      .where(and(eq(communityPins.ownerId, ownerId), eq(communityPins.communityId, communityId)))
      .returning({ position: communityPins.position });
    if (!removed) return { pinned: false };
    await t.db
      .update(communityPins)
      .set({ position: sql`${communityPins.position} - 1` })
      .where(and(eq(communityPins.ownerId, ownerId), gt(communityPins.position, removed.position)));
    await t.emit({ type: 'pin.removed', v: 1, ownerId, communityId, position: removed.position });
    return { pinned: false };
  },
});

/** Unpins a community and moves the pins after it up one; unpinning an unpinned one changes nothing. */
export const removePin = defineMutation({
  action: 'pin.remove',
  emits: ['pin.removed'],
  recheck: 'inner',
  async run(t, grant, input: void) {
    await ownerLock(t.db, grant.actorId);
    return unpinRow.within(t, grant, input);
  },
});

const moveRow = defineMutation({
  action: 'pin.move',
  emits: ['pin.moved'],
  recheck: true,
  async run(t, grant, { toPosition }: { toPosition: number }) {
    const ownerId = grant.actorId;
    const { communityId } = grant.subject;
    const pins = await shownPins(t.db, ownerId);
    const shown = pins.filter((pin) => pin.shown);
    const mover = shown.findIndex((pin) => pin.communityId === communityId);
    // A pin the owner no longer sees (unfollowed, or a closed community) is not offered to move.
    if (mover < 0) throw new Refused('pin.move', 'target.not_found');
    const to = Math.min(toPosition, shown.length - 1);
    const from = shown[mover]!.position;
    // The mover takes the stored place of the shown pin at `to`; everything stored between shifts by one.
    const target = shown[to]!.position;
    if (to === mover) return { position: to };
    const owner = eq(communityPins.ownerId, ownerId);
    if (target > from) {
      await t.db
        .update(communityPins)
        .set({ position: sql`${communityPins.position} - 1` })
        .where(and(owner, gt(communityPins.position, from), lte(communityPins.position, target)));
    } else {
      await t.db
        .update(communityPins)
        .set({ position: sql`${communityPins.position} + 1` })
        .where(and(owner, gte(communityPins.position, target), lt(communityPins.position, from)));
    }
    await t.db
      .update(communityPins)
      .set({ position: target })
      .where(and(owner, eq(communityPins.communityId, communityId)));
    await t.emit({ type: 'pin.moved', v: 1, ownerId, communityId, from, to: target });
    return { position: to };
  },
});

/**
 * Moves a pin to the shown place `toPosition` (from 0, past the end means last) in one
 * transaction. Pins hidden from the owner keep their stored order around it. A move to where it
 * already is changes nothing and emits nothing.
 */
export const movePin = defineMutation({
  action: 'pin.move',
  emits: ['pin.moved'],
  recheck: 'inner',
  async run(t, grant, input: { toPosition: number }) {
    await ownerLock(t.db, grant.actorId);
    return moveRow.within(t, grant, input);
  },
});
