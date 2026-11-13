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
import { MAX_TAG_BYTES, MAX_TAGS, PUBLIC_READ_MS } from './timing.ts';

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

/** A public answer's tags, and when its deadline clock started (performance.now() milliseconds): the body must be handed over by `startedAt + PUBLIC_BODY_MS` (stream.ts). */
export type PublicAnswer = { tags: string[]; startedAt: number };

/**
 * The Cache-Tag values for a public answer, or null for a private one. One read-only
 * repeatable-read transaction, so every fact comes from one snapshot: the purge path is ready
 * for `zoneId` (ready.ts), the kill switch is on, the supplier and every host passed are
 * allowed, the hash is not listed, and a signed-out visitor is shown the content. Null too when
 * that read took longer than PUBLIC_READ_MS from the deadline start, taken before the read
 * begins, or when the tags would exceed MAX_TAGS or MAX_TAG_BYTES (Cloudflare reads at most 16 KB
 * of them; long host names would overrun it). `clock` is for tests.
 */
export async function publicAnswerTags(
  check: PublicCheck,
  zoneId: string,
  { clock = () => performance.now(), readMs = PUBLIC_READ_MS }: { clock?: () => number; readMs?: number } = {},
): Promise<PublicAnswer | null> {
  const startedAt = clock();
  const tags = await db().transaction(
    async (q) => {
      if (!(await purgePathReady(q, zoneId))) return null;
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
  if (!tags || clock() - startedAt > readMs) return null;
  if (tags.length > MAX_TAGS || tags.join(',').length > MAX_TAG_BYTES) return null;
  return { tags, startedAt };
}
