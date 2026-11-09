import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane B1 after G0. Each key is the event type; each schema pins `v`.
export const events = {
  'post.created': type({
    type: "'post.created'",
    v: '1',
    postId: Uuid,
    communityId: Uuid,
    authorId: Uuid,
    local: 'boolean',
  }),
};
