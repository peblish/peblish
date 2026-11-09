import type { Activity } from '../mapping/records.ts';

// The activities a local moderator's action becomes (Lemmy's vocabulary, which the mapping
// writes: addressing is the mapping's, `toWire`). Who does what to which object, in which
// community; the consumer (consumer.ts) sends them.

type Base = { id: string; actorApId: string; communityApId: string | null };
const envelope = ({ id, actorApId, communityApId }: Base) => ({ id, actorApId, communityApId, raw: null });

/** A moderator's removal: Delete, with the reason as its summary. */
export const removal = (base: Base, objectApId: string, reason: string | null): Activity => ({
  ...envelope(base),
  type: 'Delete',
  objectApId,
  reason,
});

/** The Undo of a removal, embedding the Delete it takes back. */
export const restoration = (base: Base, deleteId: string, objectApId: string, reason: string | null): Activity => ({
  ...envelope(base),
  type: 'Undo',
  object: removal({ ...base, id: deleteId }, objectApId, reason),
});

export const lock = (base: Base, objectApId: string): Activity => ({ ...envelope(base), type: 'Lock', objectApId });

export const unlock = (base: Base, lockId: string, objectApId: string): Activity => ({
  ...envelope(base),
  type: 'Undo',
  object: lock({ ...base, id: lockId }, objectApId),
});

/** Pinning (Add) or unpinning (Remove) a post in the community's featured collection, or a moderator in its moderators collection. */
export const collectionChange = (base: Base, adding: boolean, objectApId: string, targetApId: string): Activity => ({
  ...envelope(base),
  type: adding ? 'Add' : 'Remove',
  objectApId,
  targetApId,
});

/** `communityApId` is the target: the community, or the instance actor for a site ban. */
export type Ban = { objectApId: string; communityApId: string; reason: string | null; removeData: boolean; expires: Date | null };

/** A community ban: Block with the community as target, `expires` and `removeData` (Lemmy). A site ban has the instance actor as target and no community in `base`. */
export const ban = (base: Base, { objectApId, communityApId, reason, removeData, expires }: Ban): Activity => ({
  ...envelope(base),
  type: 'Block',
  objectApId,
  targetApId: communityApId,
  reason,
  removeData,
  expires,
});

/** The Undo of a ban; Lemmy leaves removeData off the Block inside its Undo, so it stays null. */
export const unban = (base: Base, blockId: string, { objectApId, communityApId, reason }: Ban): Activity => ({
  ...envelope(base),
  type: 'Undo',
  object: {
    ...envelope({ ...base, id: blockId }),
    type: 'Block',
    objectApId,
    targetApId: communityApId,
    reason,
    removeData: null,
    expires: null,
  },
});

/** A local person deleting their account: a Delete of themselves, to everyone we trade follows with. */
export const accountDeletion = (id: string, actorApId: string): Activity => ({
  ...envelope({ id, actorApId, communityApId: null }),
  type: 'Delete',
  objectApId: actorApId,
  reason: null,
});
