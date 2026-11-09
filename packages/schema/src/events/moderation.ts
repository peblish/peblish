import { type } from 'arktype';
import { Uuid } from '../ids.ts';

// Owned by lane AZ after G0. `moderatorId` is null when a remote community's Announce is
// the authority and the acting moderator is unknown here. Each event carries its modlog row.
const base = { v: '1', moderatorId: Uuid.or('null'), modlogId: Uuid, local: 'boolean' } as const;

export const events = {
  /** Site ban when communityId is null, community ban otherwise; banned false is an unban. */
  'mod.ban': type({
    type: "'mod.ban'",
    ...base,
    targetActorId: Uuid,
    communityId: Uuid.or('null'),
    banned: 'boolean',
    removeContent: 'boolean',
    expiresAt: 'string.date.iso | null',
  }),
  'mod.lock': type({ type: "'mod.lock'", ...base, postId: Uuid, locked: 'boolean' }),
  'mod.feature': type({
    type: "'mod.feature'",
    ...base,
    postId: Uuid,
    scope: "'community' | 'local'",
    featured: 'boolean',
  }),
  /** role null removes the actor from the community's moderators. */
  'mod.role': type({
    type: "'mod.role'",
    ...base,
    communityId: Uuid,
    actorId: Uuid,
    role: "'owner' | 'moderator' | null",
  }),
};
