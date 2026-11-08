import { type } from 'arktype';
import { Authority } from './authz.ts';
import { Uuid } from './ids.ts';

// Owned by lane AZ after G0. One immutable modlog row; the table refuses updates and deletes.
export const ModAction = type({
  id: Uuid,
  /** Event-style name of what was done, such as 'post.remove' or 'mod.ban'. */
  action: 'string',
  moderatorId: Uuid.or('null'),
  communityId: Uuid.or('null'),
  targetActorId: Uuid.or('null'),
  targetPostId: Uuid.or('null'),
  targetCommentId: Uuid.or('null'),
  /** Statement of reasons shown to the affected user. */
  reason: 'string | null',
  authority: Authority,
  createdAt: 'Date',
});
export type ModAction = typeof ModAction.infer;
