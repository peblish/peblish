import { type } from 'arktype';
import { ActorKind, Uuid } from '../ids.ts';

// Owned by lane A after G0. Covers every actor kind: lane F emits actor.created for Groups.
const base = { v: '1', actorId: Uuid, kind: ActorKind, local: 'boolean' } as const;

export const events = {
  'actor.created': type({ type: "'actor.created'", ...base }),
  'actor.updated': type({ type: "'actor.updated'", ...base }),
  /** A soft delete: the actor row and its ap_id stay, the profile is scrubbed (FED-B federates the Delete). */
  'actor.deleted': type({ type: "'actor.deleted'", ...base }),
  /** A local account was created; inviteId is null only for the admin bootstrap. */
  'account.registered': type({ type: "'account.registered'", v: '1', actorId: Uuid, userId: Uuid, inviteId: Uuid.or('null') }),
  /** referrerId is the invite chain's parent (invites.created_by); adminId made the invite. */
  'invite.created': type({ type: "'invite.created'", v: '1', inviteId: Uuid, referrerId: Uuid, adminId: Uuid }),
  'invite.revoked': type({ type: "'invite.revoked'", v: '1', inviteId: Uuid, adminId: Uuid }),
};
