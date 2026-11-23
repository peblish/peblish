import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// The sidebar pins feature (branch 5). A person pinned, unpinned or moved a community in their
// own order (positions count from 0); owner-only, and nothing federates from these (personal.ts).
const base = { v: '1', ownerId: Uuid, communityId: Uuid } as const;
const Position = 'number.integer >= 0';

export const events = {
  /** Emitted only when the pin was new; `position` is where it went. */
  'pin.added': type({ type: "'pin.added'", ...base, position: Position }),
  /** Emitted only when there was a pin to remove; `position` is where it was. */
  'pin.removed': type({ type: "'pin.removed'", ...base, position: Position }),
  /** The pin moved from `from` to `to`; the pins between shifted by one. Not emitted for a move to where it is. */
  'pin.moved': type({ type: "'pin.moved'", ...base, from: Position, to: Position }),
};
