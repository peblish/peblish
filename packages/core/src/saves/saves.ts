import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import type { SavePost } from '@peblish/schema/inputs';
import { and, eq, inArray } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { db, type Queryable } from '../db/read.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { addSave, removeSave } from './mutations.ts';
import { savedPosts } from './tables.ts';

// The saves feature's seam (branch 5). The post reader (posts/read.ts) asks savedAmong for every
// page of posts; web calls the two entry points. The Saved page's own reader is saves/read.ts (kept
// apart: it builds on the feed reader, which imports this file).

/**
 * Which of `postIds` the viewer saved, for a page of posts at once: PostView.saved. Owner-only:
 * the viewer's own rows, none when signed out (`viewerId` null). One query through the primary key.
 */
export async function savedAmong(viewerId: Uuid | null, postIds: readonly Uuid[], q: Queryable = db()): Promise<ReadonlySet<Uuid>> {
  if (!viewerId || postIds.length === 0) return new Set();
  const rows = await q
    .select({ postId: savedPosts.postId })
    .from(savedPosts)
    .where(and(eq(savedPosts.ownerId, viewerId), inArray(savedPosts.postId, [...postIds])));
  return new Set(rows.map(({ postId }) => postId));
}

/** Saves a post for the principal; saving a saved post changes nothing. */
export async function savePostAs(principal: Principal, input: SavePost): Promise<Result<{ saved: boolean }>> {
  const decision = await authorize('save.add', principal, { postId: input.postId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => addSave(decision.grant));
}

/** Removes the principal's save of a post; unsaving an unsaved post changes nothing. */
export async function unsavePostAs(principal: Principal, input: SavePost): Promise<Result<{ saved: boolean }>> {
  const decision = await authorize('save.remove', principal, { postId: input.postId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => removeSave(decision.grant));
}
