import type { ContentRef } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { comments, posts } from '../../db/tables/content.ts';
import { allow, deny, type PolicyRequest } from '../policy.ts';
import { participationDenial } from '../state.ts';
import { isGroupPrincipal } from './posts.ts';

// Owned by lane B1. Lane AZ's guard (authz/state.ts: participationDenial) refuses bans and
// removed or deleted targets and communities. It runs first because it locks the community
// row, then the post (and the comment) FOR NO KEY UPDATE, in the lock order of state.ts. A
// vote only updates the target's own tally, but the guard still takes the post's lock for a
// comment vote, so comment votes in one thread take turns on it.
//
// Votes on locked posts stay allowed: a lock stops comments, not votes (Lemmy, AZ decision 10).
// A remote voter is allowed as itself, like a remote author: the pipeline has matched the
// signer to the Like's actor. A remote community (a Group) never votes (isGroupPrincipal).
export const policies = {
  'vote.cast': async ({ principal, subject, db, lock }: PolicyRequest<{ target: ContentRef }>) => {
    if (principal.kind === 'system') return deny('auth.required');
    // A remote community does not vote, and would deadlock on its own row (isGroupPrincipal).
    if (await isGroupPrincipal({ principal, db })) return deny('post.group_cannot_act');
    const denied = await participationDenial({ db, lock }, principal.actorId, subject.target);
    if (denied) return denied;
    if (principal.kind === 'remote') return allow({ kind: 'owner', actorId: principal.actorId });
    // The guard has locked the target and found it live; this only names its community.
    const { kind, id } = subject.target;
    const [target] =
      kind === 'post'
        ? await db.select({ communityId: posts.communityId }).from(posts).where(eq(posts.id, id))
        : await db
            .select({ communityId: posts.communityId })
            .from(comments)
            .innerJoin(posts, eq(posts.id, comments.postId))
            .where(eq(comments.id, id));
    if (!target) return deny('target.not_found');
    return allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: target.communityId });
  },
};
