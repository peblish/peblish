import { type } from 'arktype';
import { Authority } from './authz.ts';
import { Uuid } from './ids.ts';

// Owned by lane AZ after G0. One immutable modlog row; the table refuses updates and deletes.
export const ModAction = type({
  id: Uuid,
  /** The mod.* action name, such as 'mod.remove' or 'mod.site_ban' (recheck keys on the prefix). */
  action: 'string',
  /** Who acted; null once that actor row is purged, when actorApId still names them. */
  actorId: Uuid.or('null'),
  actorApId: 'string | null',
  communityId: Uuid.or('null'),
  targetActorId: Uuid.or('null'),
  targetPostId: Uuid.or('null'),
  targetCommentId: Uuid.or('null'),
  targetApId: 'string | null',
  /** Statement of reasons shown to the affected user. */
  reason: 'string | null',
  authority: Authority,
  createdAt: 'Date',
});
export type ModAction = typeof ModAction.infer;
