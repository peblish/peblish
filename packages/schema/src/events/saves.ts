import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// The saves feature (branch 5). A person saved or unsaved a post; owner-only, and nothing
// federates from these (personal.ts lists them; the federation consumers ignore them).
const base = { v: '1', ownerId: Uuid, postId: Uuid } as const;

export const events = {
  /** Emitted only when the save was new; saving a saved post emits nothing. */
  'save.added': type({ type: "'save.added'", ...base }),
  /** Emitted only when there was a save to remove. */
  'save.removed': type({ type: "'save.removed'", ...base }),
};
