import type { ContentRef } from '@peblish/schema/ids';
import { eq } from 'drizzle-orm';
import { comments, posts } from '../../db/tables/content.ts';
import { allow, deny, forShare, type PolicyRequest } from '../policy.ts';

// Owned by lane B1 after G0. Lane AZ adds a single guard call line (authz/state.ts), as in posts.ts.
export const policies = {
  'vote.cast': async ({ principal, subject, db, lock }: PolicyRequest<{ target: ContentRef }>) => {
    if (principal.kind !== 'local') return deny('auth.required');
    const { kind, id } = subject.target;
    const [target] =
      kind === 'post'
        ? await forShare(
            db.select({ communityId: posts.communityId, deletedAt: posts.deletedAt }).from(posts).where(eq(posts.id, id)),
            lock,
          )
        : await forShare(
            db
              .select({ communityId: posts.communityId, deletedAt: comments.deletedAt })
              .from(comments)
              .innerJoin(posts, eq(posts.id, comments.postId))
              .where(eq(comments.id, id)),
            lock,
          );
    if (!target) return deny('target.not_found');
    if (target.deletedAt) return deny('target.deleted');
    return allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId: target.communityId });
  },
};
