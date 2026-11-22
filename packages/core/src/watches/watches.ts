import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import type { WatchPost } from '@peblish/schema/inputs';
import { and, eq, inArray } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { db, type Queryable } from '../db/read.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { unwatchThread, watchThread } from './mutations.ts';
import { threadWatches } from './tables.ts';

// The thread-follow feature's seam (branch 5, lane f-notify). The post reader (posts/read.ts) asks
// watchingAmong for every page of posts; web calls the two entry points. The notifications consumer
// finds a thread's followers through watchers.ts and writes their `thread_reply` notices.

/**
 * Which of `postIds` the viewer follows, for a page of posts at once: PostView.watching. One
 * query on the primary key; none when signed out (`viewerId` null) or for no posts. Owner-only:
 * only the viewer's own rows are read.
 */
export async function watchingAmong(viewerId: Uuid | null, postIds: readonly Uuid[], q: Queryable = db()): Promise<ReadonlySet<Uuid>> {
  if (viewerId === null || postIds.length === 0) return new Set();
  const rows = await q
    .select({ postId: threadWatches.postId })
    .from(threadWatches)
    .where(and(eq(threadWatches.ownerId, viewerId), inArray(threadWatches.postId, [...postIds])));
  return new Set(rows.map((row) => row.postId));
}

/** Follows a thread for the principal from now on; following a followed one changes nothing. */
export async function watchThreadAs(principal: Principal, input: WatchPost): Promise<Result<{ watching: boolean }>> {
  const decision = await authorize('watch.add', principal, { postId: input.postId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => watchThread(decision.grant, undefined));
}

/** Stops following a thread; unfollowing one not followed changes nothing. */
export async function unwatchThreadAs(principal: Principal, input: WatchPost): Promise<Result<{ watching: boolean }>> {
  const decision = await authorize('watch.remove', principal, { postId: input.postId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => unwatchThread(decision.grant, undefined));
}
