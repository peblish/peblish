import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// The "new since last visit" feature (branch 5). A person's visit marker on a thread moved
// forward. Owner-only, and nothing federates from it (personal.ts lists it). It carries no
// times: the marker row has them, and the outbox keeps events for days.

export const events = {
  'visit.recorded': type({ type: "'visit.recorded'", v: '1', ownerId: Uuid, postId: Uuid }),
};
