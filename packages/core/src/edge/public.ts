import { eq } from 'drizzle-orm';
import { db, type Queryable } from '../db/read.ts';
import { comments, posts } from '../db/tables/content.ts';
import type { MediaContent } from '../media/proxy-url.ts';
import { contentShown } from '../media/reference.ts';
import { ALL_TAG, actorTag, commentTag, postTag } from './tags.ts';

// Whether a proxy answer may be held by a shared cache, decided from the content and never from
// who asks: only when the content is shown to a signed-out visitor with default choices, by the
// same rule the proxy applies to every viewer (contentShown with no viewer: not removed or
// deleted, its community live, not sensitive). The caller has already judged the kill switch,
// the supplier and the image's host, which do not depend on the viewer either.

/**
 * The Cache-Tag values for a public answer about `content` (tags.ts), or null when a signed-out
 * visitor would not be shown it, so the answer stays per viewer. A row that disappears between
 * the two reads is not public.
 */
export async function publicTags(content: Pick<MediaContent, 'kind' | 'id'>, q: Queryable = db()): Promise<string[] | null> {
  if (!(await contentShown(content, null, q))) return null;
  switch (content.kind) {
    case 'actor':
      return [ALL_TAG, actorTag(content.id)];
    case 'post': {
      const [post] = await q
        .select({ authorId: posts.authorId, communityId: posts.communityId })
        .from(posts)
        .where(eq(posts.id, content.id));
      return post ? [ALL_TAG, postTag(content.id), actorTag(post.communityId), actorTag(post.authorId)] : null;
    }
    case 'comment': {
      const [comment] = await q
        .select({ authorId: comments.authorId, postId: posts.id, postAuthorId: posts.authorId, communityId: posts.communityId })
        .from(comments)
        .innerJoin(posts, eq(posts.id, comments.postId))
        .where(eq(comments.id, content.id));
      if (!comment) return null;
      const actors = [...new Set([comment.communityId, comment.postAuthorId, comment.authorId])];
      return [ALL_TAG, commentTag(content.id), postTag(comment.postId), ...actors.map(actorTag)];
    }
  }
}
