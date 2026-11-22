import type { SavePost } from '@peblish/schema/inputs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { posts } from '../../db/tables/content.ts';
import { communityRemovals } from '../../moderation/tables.ts';
import { feedPredicate as ageGate } from '../../posts/feed-predicate.ts';
import { allow, deny, forShare, type PolicyRequest } from '../policy.ts';

// Owned by lane f-saves: a local person saves or unsaves a post for themselves (owner-only, nothing
// federates). Only the post row is read FOR SHARE, never its community: a save does not wait for votes
// or moderation in the community, and cannot close a lock cycle with them. A post that is removed or
// deleted after it was saved simply leaves the Saved page (saves/read.ts applies the feeds' rules).
// A sensitive or NSFL post (or community) answers as missing to someone without the 16+
// declaration, as the post page shows them only the gate: the feeds' nsfw-gate predicate, until
// the age check for writes arrives from main and takes its place.

export const policies = {
  /** A signed-in local person saves a live post of an open community they may open; any other id is not found. */
  'save.add': async ({ principal, subject, db, lock }: PolicyRequest<SavePost>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    const [post] = await forShare(
      db
        .select({ communityId: posts.communityId })
        .from(posts)
        .where(
          and(
            eq(posts.id, subject.postId),
            isNull(posts.deletedAt),
            isNull(posts.removedAt),
            sql`exists (select 1 from actors as open_community where open_community.id = ${posts.communityId} and open_community.kind = 'Group' and open_community.deleted_at is null)`,
            sql`not exists (select 1 from ${communityRemovals} where ${communityRemovals.communityId} = ${posts.communityId})`,
            ageGate.where({ actorId: principal.actorId }),
          ),
        ),
      lock,
    );
    if (!post) return deny('target.not_found');
    return allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: post.communityId });
  },

  /** A signed-in local person removes one of their own saves, whatever became of the post. */
  'save.remove': async ({ principal }: PolicyRequest<SavePost>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    return allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: null });
  },
};
