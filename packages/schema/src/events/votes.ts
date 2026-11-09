import { type } from 'arktype';
import { ContentRef, Uuid } from '../ids.ts';

// Owned by lane B1 after G0; the wave 2 groundwork fixed these fields for lanes B1 and FED-A,
// and B1 must not change them. `value` 0 is a retracted vote; `previous` lets consumers apply
// count deltas without reading history. The vote row is deleted on a change of direction or a
// retraction, so the event is the only place the replaced vote's activity id survives, for
// the outbound Undo. Nothing emitted vote.cast before these fields, so it stays v 1.
export const events = {
  'vote.cast': type({
    type: "'vote.cast'",
    v: '1',
    voterId: Uuid,
    target: ContentRef,
    value: '-1 | 0 | 1',
    previous: '-1 | 0 | 1',
    /** The new Like or Dislike activity's id; null when `value` is 0. */
    apId: 'string | null',
    /** The replaced vote's activity id; null when `previous` is 0. */
    previousApId: 'string | null',
    local: 'boolean',
  }),
};
