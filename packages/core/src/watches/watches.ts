import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import type { WatchPost } from '@peblish/schema/inputs';
import { db, type Queryable } from '../db/read.ts';
import type { Result } from '../identity/result.ts';

// The thread-follow feature's seam (branch 5). The post reader (posts/read.ts) asks watchingAmong
// for every page of posts; web calls the two entry points. Until the feature lands nobody follows
// a thread: watchingAmong answers none without a query, and the entry points refuse as if the
// post were not there. The notifications lane fills in this file and adds its mutations, policy,
// fan-out and tests beside it, without touching a reader.

/**
 * Which of `postIds` the viewer follows, for a page of posts at once: PostView.watching.
 * Owner-only: the viewer's own rows, none when signed out (`viewerId` null).
 */
export async function watchingAmong(_viewerId: Uuid | null, _postIds: readonly Uuid[], _q: Queryable = db()): Promise<ReadonlySet<Uuid>> {
  return new Set();
}

/** Follows a thread for the principal from now on; following a followed one changes nothing. */
export async function watchThreadAs(_principal: Principal, _input: WatchPost): Promise<Result<{ watching: boolean }>> {
  return { ok: false, reason: 'target.not_found' };
}

/** Stops following a thread; unfollowing one not followed changes nothing. */
export async function unwatchThreadAs(_principal: Principal, _input: WatchPost): Promise<Result<{ watching: boolean }>> {
  return { ok: false, reason: 'target.not_found' };
}
