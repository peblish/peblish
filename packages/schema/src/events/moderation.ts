import { type } from 'arktype';
import { ContentRef, Uuid } from '../ids.ts';

// Owned by lane AZ after G0. Each event carries its modlog row (modlogId), which also keeps
// the actor's, the community's and the target's ap_ids. `moderatorId` is the acting actor;
// null only when a remote community's Announce is the authority and the moderator is unknown
// here. `local` is true when the action was taken on this instance (federate it out) and
// false when it arrived from a peer. Lane FED-B maps them: mod.remove to Delete with summary
// (removed) or Undo (restored), mod.lock to Lock or Undo, mod.feature to the featured
// collection, mod.ban to Block (with endTime and removeData) or Undo.
const base = { v: '1', moderatorId: Uuid.or('null'), modlogId: Uuid, local: 'boolean' } as const;

export const events = {
  /** A post or comment removed by a moderator (removed true) or restored (false). */
  'mod.remove': type({
    type: "'mod.remove'",
    ...base,
    communityId: Uuid,
    target: ContentRef,
    targetApId: 'string',
    removed: 'boolean',
    reason: 'string | null',
  }),
  /** Site ban when communityId is null, community ban otherwise; banned false is an unban. */
  'mod.ban': type({
    type: "'mod.ban'",
    ...base,
    targetActorId: Uuid,
    targetApId: 'string',
    communityId: Uuid.or('null'),
    banned: 'boolean',
    removeContent: 'boolean',
    expiresAt: 'string.date.iso | null',
    reason: 'string | null',
  }),
  'mod.lock': type({
    type: "'mod.lock'",
    ...base,
    communityId: Uuid,
    postId: Uuid,
    targetApId: 'string',
    locked: 'boolean',
    reason: 'string | null',
  }),
  /** scope 'community' is a moderator's pin (mod.pin, mod.unpin); 'local' is the site's front page. */
  'mod.feature': type({
    type: "'mod.feature'",
    ...base,
    communityId: Uuid,
    postId: Uuid,
    targetApId: 'string',
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
