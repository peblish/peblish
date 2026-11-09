import { type } from 'arktype';
import { ActorKind, Uuid } from '../ids.ts';

// Owned by lane A after G0. Covers every actor kind: lane F emits actor.created for Groups.
const base = { v: '1', actorId: Uuid, kind: ActorKind, local: 'boolean' } as const;

export const events = {
  'actor.created': type({ type: "'actor.created'", ...base }),
  'actor.updated': type({ type: "'actor.updated'", ...base }),
  'actor.deleted': type({ type: "'actor.deleted'", ...base }),
};
