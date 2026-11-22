import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import type { SavePost } from '@peblish/schema/inputs';
import { db, type Queryable } from '../db/read.ts';
import type { Result } from '../identity/result.ts';

// The saves feature's seam (branch 5). The post reader (posts/read.ts) asks savedAmong for every
// page of posts; web calls the two entry points. Until the feature lands it holds no saves:
// savedAmong answers none without a query, and the entry points refuse as if the post were not
// there. The saves lane fills in this file and adds its mutations, policy, Saved page reader and
// tests beside it, without touching a reader.

/**
 * Which of `postIds` the viewer saved, for a page of posts at once: PostView.saved. Owner-only:
 * the viewer's own rows, none when signed out (`viewerId` null).
 */
export async function savedAmong(_viewerId: Uuid | null, _postIds: readonly Uuid[], _q: Queryable = db()): Promise<ReadonlySet<Uuid>> {
  return new Set();
}

/** Saves a post for the principal; saving a saved post changes nothing. */
export async function savePostAs(_principal: Principal, _input: SavePost): Promise<Result<{ saved: boolean }>> {
  return { ok: false, reason: 'target.not_found' };
}

/** Removes the principal's save of a post; unsaving an unsaved post changes nothing. */
export async function unsavePostAs(_principal: Principal, _input: SavePost): Promise<Result<{ saved: boolean }>> {
  return { ok: false, reason: 'target.not_found' };
}
