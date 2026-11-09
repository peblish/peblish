import { type } from 'arktype';
import { ContentRef, Uuid } from '../ids.ts';

// Owned by lane B1 after G0. `value` 0 is a retracted vote; `previous` lets consumers
// apply count deltas without reading history.
export const events = {
  'vote.cast': type({
    type: "'vote.cast'",
    v: '1',
    voterId: Uuid,
    target: ContentRef,
    value: '-1 | 0 | 1',
    previous: '-1 | 0 | 1',
    local: 'boolean',
  }),
};
