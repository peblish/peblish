import type { Uuid } from '@peblish/schema/ids';
import { authorize } from '../authz/authorize.ts';
import { communityBlockedFor } from './read.ts';

/**
 * Whether the composer may start in the community for this member (web's picker): the directory's
 * block rules do not hide it from them (communityBlockedFor), and post.create's precheck allows
 * the post outright. That policy answers for the community (it is live, past the age gate, they
 * are not banned, a mods-only one has them as staff) and for the member (a verified email,
 * posting switched on), and a refusal of either refuses here: a member who may post nowhere
 * starts nowhere. Anything else starts the form as if no community had been asked for.
 */
export async function mayStartPostIn(viewer: { actorId: Uuid; siteRole: 'user' | 'admin' }, communityId: Uuid): Promise<boolean> {
  if (await communityBlockedFor(viewer.actorId, communityId)) return false;
  const principal = { kind: 'local', actorId: viewer.actorId, siteRole: viewer.siteRole } as const;
  return (await authorize('post.create', principal, { communityId })).ok;
}
