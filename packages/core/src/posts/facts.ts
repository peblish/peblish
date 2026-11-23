import type { Uuid } from '@peblish/schema/ids';
import { sql } from 'drizzle-orm';
import { actorBlockedBy } from '../blocks/predicate.ts';
import { db, type Queryable } from '../db/read.ts';
import { comments, posts } from '../db/tables/content.ts';
import type { Viewer } from './read.ts';

// The post rail's thread facts (Commons, branch 5): who took part, when the thread last moved and
// its language, from this server's copy. Bounded: one read of at most `participantScan` comments
// over the thread's own index range, so a large thread costs no more than that.

/** The most comments one read looks at; past it the participants are "at least" and the last activity is unknown. */
export const participantScan = 1000;

export type ThreadFacts = {
  /** The post's author and the authors of the live comments the viewer is shown, each once. */
  participants: number;
  /** True when the thread has more comments than one read looks at: `participants` is a floor. */
  more: boolean;
  /** The newest live comment shown to the viewer, else the post itself; null when unknown (`more`). */
  lastActivityAt: string | null;
  /** The language the post declares (a BCP 47 tag), or null when it declares none. */
  language: string | null;
};

/**
 * The facts of the thread under `postId` for `viewer`, or null when there is no such post. The
 * caller asks only for a post it shows (not withheld, not gated). A comment counts when it is live
 * and not by someone the viewer blocks (directly or through their instance), as the thread shows it.
 */
export async function threadFacts(postId: Uuid, viewer: Viewer, q: Queryable = db()): Promise<ThreadFacts | null> {
  const shown = viewer ? sql`and not ${actorBlockedBy(viewer.actorId, sql`sample_comment.author_id`)}` : sql``;
  const [row] = await q.execute<{
    author: Uuid;
    published: number;
    language: string | null;
    scanned: number;
    people: number;
    latest: number | null;
  }>(
    sql`with thread as (
      select ${posts.authorId} as author, ${posts.publishedAt} as published, ${posts.language} as language from ${posts} where ${posts.id} = ${postId}::uuid
    ), sample as (
      select sample_comment.author_id, sample_comment.published_at from ${comments} as sample_comment
      where sample_comment.post_id = ${postId}::uuid and sample_comment.deleted_at is null and sample_comment.removed_at is null ${shown}
      limit ${participantScan + 1}
    )
    select thread.author, (extract(epoch from thread.published) * 1000)::float8 as published, thread.language,
      (select count(*) from sample)::int as scanned,
      (select count(*) from (select author_id from sample union select thread.author) as people)::int as people,
      (extract(epoch from (select max(published_at) from sample)) * 1000)::float8 as latest
    from thread`,
  );
  if (!row) return null;
  const more = row.scanned > participantScan;
  return {
    participants: row.people,
    more,
    lastActivityAt: more ? null : new Date(Number(row.latest ?? row.published)).toISOString(),
    language: row.language,
  };
}
