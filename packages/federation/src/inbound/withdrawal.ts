import { db, type Queryable } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { comments, posts } from '@peblish/core/db/tables/content';
import { eq } from 'drizzle-orm';
import type { JsonObject } from '../mapping/json.ts';
import { storedContent } from './authorize.ts';
import { addressedToPublic } from './visibility.ts';

// An Update that takes Public away from a post or comment we hold must remove our copy
// (handlers/_content.ts), whatever else it now says: a top-level Note that no longer names its
// community, a Page made into a poll or a type we do not read. So it is judged by the copy we
// hold, not by its new shape: classify.ts (direct and announced Updates) and the Announce
// handler (the origin's copy of one) give it the held object's kind and community before it is
// mapped. Only its id, author and addressing are kept, which is all the removal reads; nothing
// of it is stored.

/** What the reshaping needs of the copy we hold. */
export type Held = { kind: 'post' | 'comment'; communityApId: string; inReplyToApId: string | null };

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null =>
  typeof value === 'string' ? value : isObject(value) && typeof value.id === 'string' ? value.id : null;

/** The held copy's kind, community and parent, by ap_id; null when we hold no such post or comment. */
export async function heldContent(apId: string, q: Queryable = db()): Promise<Held | null> {
  const held = await storedContent(q, apId);
  if (!held) return null;
  const [community] = await q.select({ apId: actors.apId }).from(actors).where(eq(actors.id, held.communityId));
  if (!community) return null;
  if (held.kind === 'post') return { kind: 'post', communityApId: community.apId, inReplyToApId: null };
  const parent = held.parentId
    ? (await q.select({ apId: comments.apId }).from(comments).where(eq(comments.id, held.parentId)))[0]
    : (await q.select({ apId: posts.apId }).from(posts).where(eq(posts.id, held.postId)))[0];
  return parent ? { kind: 'comment', communityApId: community.apId, inReplyToApId: parent.apId } : null;
}

/**
 * The id of the object an Update takes Public away from (the object or the Update itself not
 * addressed to it), whatever the object's type, or null. Only an id we hold counts (heldContent),
 * so an actor's Update can never match.
 */
export function withdrawnId(activity: JsonObject): string | null {
  const object = activity.object;
  if (activity.type !== 'Update' || !isObject(object)) return null;
  return addressedToPublic(object) && addressedToPublic(activity) ? null : idOf(object);
}

/** The Update with its object reshaped as the held copy's kind and community, its id, author and addressing kept. */
export function asWithdrawal(activity: JsonObject, held: Held): JsonObject {
  const object = isObject(activity.object) ? activity.object : {};
  const kept = {
    id: idOf(activity.object),
    attributedTo: object.attributedTo ?? activity.actor ?? null,
    content: '',
    audience: held.communityApId,
    to: object.to ?? [],
    cc: object.cc ?? [],
  };
  const shaped =
    held.kind === 'post' ? { ...kept, type: 'Page', name: 'withdrawn' } : { ...kept, type: 'Note', inReplyTo: held.inReplyToApId };
  return { ...activity, object: shaped };
}
