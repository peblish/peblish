import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane E1. A local person's block list changed. `targetId` is the blocked person's or
// community's actor id, or the instance's id. Nothing federates from these: a community block
// also ends the follow, and that goes out as follow.removed.
const base = { v: '1', blockerId: Uuid, kind: "'person' | 'community' | 'instance'", targetId: Uuid } as const;

export const events = {
  /** Emitted only when the block was created; blocking twice emits nothing. */
  'block.added': type({ type: "'block.added'", ...base }),
  'block.removed': type({ type: "'block.removed'", ...base }),
};
