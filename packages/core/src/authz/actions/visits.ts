import type { Uuid } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { posts } from '../../db/tables/content.ts';
import { communityRemovals } from '../../moderation/tables.ts';
import { allow, deny, type PolicyRequest } from '../policy.ts';

// Owned by lane f-visits: a signed-in local person records that they opened a thread (visits/).
// The marker is the person's own and shows nothing to anyone else, so the rule is only that the
// thread is one this server still shows: the post exists, is not removed, and its community is
// neither deleted nor removed. A deleted post keeps its thread (the page lists its comments), so
// it is allowed; a community ban does not stop reading, so it does not refuse either.
//
// The reads take no row lock, even in the recheck. A visit happens on every page view, and a
// lock on the post or community row (state.ts takes FOR NO KEY UPDATE) would queue page views
// behind every vote and comment there. The marker's foreign key already holds the post against
// a purge, and a removal that commits beside a visit leaves a private marker that shows nothing.

export const policies = {
  'visit.record': async ({ principal, subject, db }: PolicyRequest<{ postId: Uuid }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    const [post] = await db
      .select({ removedAt: posts.removedAt, communityDeletedAt: actors.deletedAt, communityRemovedAt: communityRemovals.removedAt })
      .from(posts)
      .innerJoin(actors, eq(actors.id, posts.communityId))
      .leftJoin(communityRemovals, eq(communityRemovals.communityId, posts.communityId))
      .where(eq(posts.id, subject.postId));
    if (!post || post.communityDeletedAt || post.communityRemovedAt) return deny('target.not_found');
    if (post.removedAt) return deny('target.removed');
    return allow({ kind: 'owner', actorId: principal.actorId });
  },
};
