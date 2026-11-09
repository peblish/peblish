import { authorize } from '@peblish/core/authz/authorize';
import { resolveReplyTarget, storeRemoteComment } from '@peblish/core/comments/remote';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { comments, posts } from '@peblish/core/db/tables/content';
import { storeRemotePost } from '@peblish/core/posts/remote';
import { deleteRemoteObject } from '@peblish/core/remote/objects';
import { Refused } from '@peblish/core/tx/refused';
import type { ActingPrincipal } from '@peblish/schema/authz';
import { eq } from 'drizzle-orm';
import { fetchActivity, FetchFailure, type Fetcher } from '../actors/document.ts';
import { importGrant } from '../actors/grants.ts';
import { ActorResolveError, resolveRemoteActor, type ResolvedActor } from '../actors/resolve.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import { checkObject } from '../inbound/authorize.ts';
import { requeueSkippedFor } from '../inbound/queue.ts';
import { Skipped } from '../inbound/reasons.ts';
import { fromWire } from '../mapping/document.ts';
import { MappingError } from '../mapping/json.ts';
import type { CommentRecord, PostRecord } from '../mapping/records.ts';

// Fetching a post or comment on demand, and storing a document in hand, for the code that
// reads peers in bulk (the backfill) or after the fact (the missing-object job). Everything
// that reaches the database goes through the mutations FED-B's handlers use, authorized as the
// object's author, and the network is used before and between those writes, never inside one.
//
// An object is stored under a community's vouching (`Vouch`): the community served it from its
// own collection, or announced an activity about it. Without that nothing is stored, as the
// inbound pipeline stores nothing for a remote community that did not announce it.

/** The remote community that stands behind what is stored, and the document it vouches with (an Announce id, a collection's URL). */
export type Vouch = { community: { id: string; apId: string }; announceApId: string };

export type ObjectOutcome =
  | { status: 'stored'; kind: 'post' | 'comment'; apId: string; created: boolean }
  /** The peer answered 410 or a Tombstone. `deleted` says whether a copy we held was soft-deleted for it. */
  | { status: 'gone'; apId: string; deleted: boolean }
  /** The peer could not be reached (down, slow): try again later. */
  | { status: 'unreachable'; apId: string; detail: string }
  /** Not stored, and asking again will not change it: a reason from the inbound reasons or a refusal. */
  | { status: 'refused'; apId: string; reason: string };

/** Ancestors of a comment fetched to give it a place; a longer chain is left (the comment is refused as `parent.missing`). */
export const maxParentDepth = 5;

const refused = (apId: string, reason: string): ObjectOutcome => ({ status: 'refused', apId, reason });
const unreachable = (apId: string, detail: string): ObjectOutcome => ({ status: 'unreachable', apId, detail });

/** A peer's failure that may pass: it is down or slow, or it asked us to slow down. */
export const isTransient = (error: FetchFailure): boolean =>
  error.reason === 'unreachable' || (error.status !== undefined && (error.status >= 500 || error.status === 429 || error.status === 408));

export const isTombstone = (json: unknown): boolean =>
  typeof json === 'object' && json !== null && 'type' in json && json.type === 'Tombstone';

const idOf = (json: unknown): string =>
  typeof json === 'object' && json !== null && 'id' in json && typeof json.id === 'string' ? json.id : '(no id)';

/** A copy we hold of a deleted-at-the-source object is soft-deleted, and the outcome says so. */
async function gone(apId: string): Promise<ObjectOutcome> {
  const { deleted } = await deleteRemoteObject(await importGrant('remote.object_delete', { apId }));
  return { status: 'gone', apId, deleted };
}

/**
 * GETs the object at `apId` from its own origin (signed as the instance, through safeFetch). A
 * 410, or a Tombstone, is an outcome of its own (`gone`), not an error.
 */
export async function readObject(apId: string, fetch: Fetcher): Promise<{ json: unknown } | ObjectOutcome> {
  try {
    const { json } = await fetchActivity(apId, fetch);
    return isTombstone(json) ? await gone(apId) : { json };
  } catch (error) {
    if (!(error instanceof FetchFailure)) throw error;
    if (error.reason === 'gone') return gone(apId);
    return isTransient(error) ? unreachable(apId, error.message) : refused(apId, `object.${error.reason}`);
  }
}

/** The community a stored remote post or comment lives in, as a vouch for refetching it; null for an object we do not hold. */
export async function heldVouch(apId: string): Promise<Vouch | null> {
  const [post] = await db()
    .select({ id: actors.id, apId: actors.apId })
    .from(posts)
    .innerJoin(actors, eq(actors.id, posts.communityId))
    .where(eq(posts.apId, apId));
  const [comment] = post
    ? []
    : await db()
        .select({ id: actors.id, apId: actors.apId })
        .from(comments)
        .innerJoin(posts, eq(posts.id, comments.postId))
        .innerJoin(actors, eq(actors.id, posts.communityId))
        .where(eq(comments.apId, apId));
  const community = post ?? comment;
  return community ? { community, announceApId: apId } : null;
}

/**
 * Fetches the post or comment at `apId` and stores it. `vouch` names the remote community that
 * stands behind it; for an object we already hold it may be left out (the stored community
 * is used), which is how a copy is checked against its source: a 410 or a Tombstone soft-deletes
 * it, a document that is still served changes nothing (`created: false`).
 */
export async function fetchRemoteObject(
  apId: string,
  options: { vouch?: Vouch; fetch?: Fetcher; depth?: number } = {},
): Promise<ObjectOutcome> {
  const fetch = options.fetch ?? safeFetch;
  const vouch = options.vouch ?? (await heldVouch(apId));
  if (!vouch) return refused(apId, 'object.unvouched');
  const read = await readObject(apId, fetch);
  if (!('json' in read)) return read;
  return storeObject(read.json, vouch, { fetch, depth: options.depth ?? 0 });
}

/**
 * Stores the post or comment `json` describes under `vouch`. The document is held to the
 * inbound rules: it lives on its author's origin and names the author, a post names the
 * vouching community, remote sensitive content is refused, and the policies of post.create and
 * comment.create decide the rest (a banned author, a locked post, a removed community). A
 * comment whose parent we do not hold has the parent fetched first, up to `maxParentDepth`.
 */
export async function storeObject(json: unknown, vouch: Vouch, options: { fetch: Fetcher; depth: number }): Promise<ObjectOutcome> {
  let mapped;
  try {
    mapped = fromWire(json);
  } catch (error) {
    if (error instanceof MappingError) return refused(idOf(json), 'object.unsupported');
    throw error;
  }
  try {
    if (mapped.kind === 'post') return await storePost(mapped.post, vouch, options.fetch);
    if (mapped.kind === 'comment') return await storeComment(mapped.comment, vouch, options);
  } catch (error) {
    // A skip from the inbound checks, or a refusal from a policy's recheck: this object, not the run, is refused.
    if (error instanceof Skipped) return refused(idOf(json), error.reason);
    if (error instanceof Refused) return refused(idOf(json), error.reason);
    throw error;
  }
  return refused(idOf(json), 'object.unsupported');
}

type Author = { actor: ResolvedActor } | { outcome: ObjectOutcome };

async function authorOf(apId: string, objectApId: string, fetch: Fetcher): Promise<Author> {
  try {
    return { actor: await resolveRemoteActor(apId, { fetch }) };
  } catch (error) {
    if (!(error instanceof ActorResolveError)) throw error;
    return { outcome: error.transient ? unreachable(objectApId, error.message) : refused(objectApId, 'actor.unresolvable') };
  }
}

/** The author as the policies read a remote person vouched for by a community: its Announce is the authority. */
const principalOf = (author: ResolvedActor, vouch: Vouch): ActingPrincipal => ({
  kind: 'remote',
  actorId: author.id,
  announcedBy: { communityId: vouch.community.id, announceApId: vouch.announceApId },
});

async function storePost(post: PostRecord, vouch: Vouch, fetch: Fetcher): Promise<ObjectOutcome> {
  checkObject(post.authorApId, post);
  if (post.communityApId !== vouch.community.apId) return refused(post.apId, 'community.mismatch');
  // The inbound rule, until the setting that relaxes it comes with the admin controls (handlers/_content.ts).
  if (post.sensitive || post.nsfl) return refused(post.apId, 'content.nsfw_rejected');
  const author = await authorOf(post.authorApId, post.apId, fetch);
  if ('outcome' in author) return author.outcome;
  const decision = await authorize('post.create', principalOf(author.actor, vouch), { communityId: vouch.community.id });
  if (!decision.ok) return refused(post.apId, decision.reason);
  const { created } = await storeRemotePost(decision.grant, post);
  // Activities that were skipped for want of this post apply on the inbound job's next run.
  await requeueSkippedFor(post.apId);
  return { status: 'stored', kind: 'post', apId: post.apId, created };
}

async function storeComment(comment: CommentRecord, vouch: Vouch, options: { fetch: Fetcher; depth: number }): Promise<ObjectOutcome> {
  checkObject(comment.authorApId, comment);
  let target = await resolveReplyTarget(comment.inReplyToApId);
  if (!target) {
    if (options.depth >= maxParentDepth) return refused(comment.apId, 'parent.missing');
    const parent = await fetchRemoteObject(comment.inReplyToApId, { vouch, fetch: options.fetch, depth: options.depth + 1 });
    if (parent.status === 'unreachable') return unreachable(comment.apId, parent.detail);
    target = parent.status === 'stored' ? await resolveReplyTarget(comment.inReplyToApId) : null;
    if (!target) return refused(comment.apId, 'parent.missing');
  }
  const author = await authorOf(comment.authorApId, comment.apId, options.fetch);
  if ('outcome' in author) return author.outcome;
  const decision = await authorize('comment.create', principalOf(author.actor, vouch), target);
  if (!decision.ok) return refused(comment.apId, decision.reason);
  const { created } = await storeRemoteComment(decision.grant, comment);
  await requeueSkippedFor(comment.apId);
  return { status: 'stored', kind: 'comment', apId: comment.apId, created };
}
