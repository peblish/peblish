import type { ContentRef } from '@peblish/schema/ids';
import { allow, deny, type PolicyRequest } from '../policy.ts';
import { ageDenial, contentState, flaggedContent, participation } from '../state.ts';
import { isGroupPrincipal } from './posts.ts';

// Owned by lane B1. Lane AZ's guard (authz/state.ts: participationDenial, here as contentState
// and participation, so the policy keeps the state it read) refuses bans and removed or deleted
// targets and communities. It runs first because it locks the community row, then the post (and
// the comment) FOR NO KEY UPDATE, in the lock order of state.ts. A
// vote only updates the target's own tally, but the guard still takes the post's lock for a
// comment vote, so comment votes in one thread take turns on it.
//
// Votes on locked posts stay allowed: a lock stops comments, not votes (Lemmy, AZ decision 10).
// A remote voter is allowed as itself, like a remote author: the pipeline has matched the
// signer to the Like's actor. A remote community (a Group) never votes (isGroupPrincipal).
// A local voter passes the age gate (ageDenial): what the page withholds from them takes no vote.
export const policies = {
  'vote.cast': async ({ principal, subject, db, lock }: PolicyRequest<{ target: ContentRef }>) => {
    if (principal.kind === 'system') return deny('auth.required');
    // A remote community does not vote, and would deadlock on its own row (isGroupPrincipal).
    if (await isGroupPrincipal({ principal, db })) return deny('post.group_cannot_act');
    const target = await contentState({ db, lock }, subject.target);
    if (!target) return deny('target.not_found');
    const denied =
      (await participation({ db, lock }, principal.actorId, target)) ?? (await ageDenial({ db, lock }, principal, flaggedContent(target)));
    if (denied) return denied;
    if (principal.kind === 'remote') return allow({ kind: 'owner', actorId: principal.actorId });
    return allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: target.community.id });
  },
};
