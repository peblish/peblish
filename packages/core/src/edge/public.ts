import { eq } from 'drizzle-orm';
import { db, type Queryable } from '../db/read.ts';
import { comments, posts } from '../db/tables/content.ts';
import type { MediaContent } from '../media/proxy-url.ts';
import { contentShown } from '../media/reference.ts';
import { findBlocked } from '../mediascan/blocklist.ts';
import { mediaAllowed, supplierMediaAllowed } from '../peers/gate.ts';
import { readSetting } from '../settings/read.ts';
import { purgePathReady } from './ready.ts';
import { ALL_TAG, actorTag, commentTag, hashTag, hostTags, postTag } from './tags.ts';
import { PUBLIC_DEADLINE_MS } from './timing.ts';

// Whether a proxy answer may be held by a shared cache, decided from the content, the hosts and
// the bytes, never from who asks: only when the content is shown to a signed-out visitor with
// default choices, by the same rule the proxy applies to every viewer (contentShown with no
// viewer: not removed or deleted, its community live, not sensitive), and everything else a
// public copy rests on holds in the same snapshot (publicAnswerTags).

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

/** What the proxy knows once it holds the image: the content it was signed for, every host it was fetched through, and its hash. */
export type PublicCheck = { content: MediaContent; hosts: readonly string[]; sha256: string };

/**
 * The Cache-Tag values for a public answer, or null for a private one. One read-only
 * repeatable-read transaction, so every fact comes from one snapshot: the purge path is ready
 * (ready.ts), the kill switch is on, the supplier and every host passed are allowed, the hash is
 * not listed, and a signed-out visitor is shown the content. Null too when that read took longer
 * than PUBLIC_DEADLINE_MS from its start (timing.ts), so a public answer always leaves within
 * the deadline of its snapshot. Called after the image is fetched; the caller sends the answer
 * at once. `clock` is for tests.
 */
export async function publicAnswerTags(
  check: PublicCheck,
  { clock = () => performance.now(), deadlineMs = PUBLIC_DEADLINE_MS }: { clock?: () => number; deadlineMs?: number } = {},
): Promise<string[] | null> {
  const started = clock();
  const tags = await db().transaction(
    async (q) => {
      if (!(await purgePathReady(q))) return null;
      if (!(await readSetting('remote_media.enabled', q))) return null;
      const { supplier } = check.content;
      if (supplier && !(await supplierMediaAllowed(supplier, q))) return null;
      for (const host of check.hosts) if (!(await mediaAllowed(host, q))) return null;
      if (await findBlocked(q, check.sha256)) return null;
      const content = await publicTags(check.content, q);
      if (!content) return null;
      const hosts = [...(supplier ? [supplier] : []), ...check.hosts].flatMap(hostTags);
      return [...new Set([...content, ...hosts, hashTag(check.sha256)])];
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  return tags && clock() - started <= deadlineMs ? tags : null;
}
