import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane B1 after G0; the wave 2 groundwork fixed these fields for lanes B1 and FED-A,
// and B1 must not change them. Each key is the event type; each schema pins `v`. `local` is
// true when the post was written on this instance (federate it out) and false when it
// arrived from a peer. A moderator's removal is not one of these: it is mod.remove (lane AZ).
const base = { v: '1', postId: Uuid, communityId: Uuid, authorId: Uuid, local: 'boolean' } as const;

export const events = {
  'post.created': type({ type: "'post.created'", ...base }),
  /** The author's edit. */
  'post.updated': type({ type: "'post.updated'", ...base }),
  /** The author's delete. */
  'post.deleted': type({ type: "'post.deleted'", ...base }),
  /** The author's undo of their delete. */
  'post.restored': type({ type: "'post.restored'", ...base }),
};
