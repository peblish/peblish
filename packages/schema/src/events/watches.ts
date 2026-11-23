import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// The thread-follow feature (branch 5). A person followed or stopped following a thread;
// owner-only, and nothing federates from these (personal.ts lists them).
const base = { v: '1', ownerId: Uuid, postId: Uuid } as const;

export const events = {
  /** Emitted only when the follow was new. */
  'watch.added': type({ type: "'watch.added'", ...base }),
  /** Emitted only when there was a follow to remove. */
  'watch.removed': type({ type: "'watch.removed'", ...base }),
};
