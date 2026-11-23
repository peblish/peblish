import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { posts } from '../../db/tables/content.ts';
import { ageDeclarations } from '../../identity/tables.ts';
import { allow, deny, type PolicyRequest } from '../policy.ts';
import { communityDenial, liveDenial, postState } from '../state.ts';

// Owned by lane f-notify: following a thread (watches/watches.ts). Owner-only: the follower is
// always the acting person, never an id from the request. Lock order as everywhere: postState
// takes the community's actor row, then the post (authz/state.ts).

export const policies = {
  /**
   * A signed-in local person follows a thread they may read: the post and its community exist
   * and are neither deleted nor removed, and a sensitive or NSFL post or community needs their
   * 16+ declaration (the gate's per-browser Hide NSFW choice is not the account's, so it does not
   * count here). Anything else answers as if there were no such post.
   */
  'watch.add': async ({ principal, subject, db, lock }: PolicyRequest<{ postId: Uuid }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    const post = await postState({ db, lock }, subject.postId);
    if (!post) return deny('target.not_found');
    const closed = communityDenial(post.community) ?? liveDenial(post);
    if (closed) return closed;
    const [flags] = await db
      .select({ sensitive: posts.sensitive, nsfl: posts.nsfl, communitySensitive: actors.sensitive, communityNsfl: actors.nsfl })
      .from(posts)
      .innerJoin(actors, eq(actors.id, posts.communityId))
      .where(eq(posts.id, post.id));
    if (!flags) return deny('target.not_found');
    if (flags.sensitive || flags.nsfl || flags.communitySensitive || flags.communityNsfl) {
      const [declared] = await db
        .select({ actorId: ageDeclarations.actorId })
        .from(ageDeclarations)
        .where(eq(ageDeclarations.actorId, principal.actorId));
      if (!declared) return deny('target.not_found');
    }
    return allow({ kind: 'owner', actorId: principal.actorId });
  },

  /** A signed-in local person stops following a thread: always theirs to undo, whatever became of the post. */
  'watch.remove': async ({ principal }: PolicyRequest<{ postId: Uuid }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    return allow({ kind: 'owner', actorId: principal.actorId });
  },
};
