import { MappingError, type JsonObject } from '../mapping/json.ts';
import { addressesOf, noteAsPage } from './microblog.ts';
import { skip, type Skipped } from './reasons.ts';
import { notPublic } from './visibility.ts';

// What an inbox document is, before the mapping reads it. The mapping is strict about the
// shapes it knows and throws MappingError for the rest; that error is permanent (the row
// fails and is never retried). This step sorts out what is not malformed but is not ours to
// map: a type we do not read, a poll, an Announce of a bare IRI, and it rewrites what the
// mapping cannot read yet but we decided how to store: a Note that replies to nothing
// (a microblog post to a community), an Accept that names its Follow by IRI only (skipped) and a Reject that does (given its Follow).

const handledTypes = new Set([
  'Create',
  'Update',
  'Delete',
  'Like',
  'Dislike',
  'Undo',
  'Lock',
  'Add',
  'Remove',
  'Block',
  'Follow',
  'Accept',
  'Reject',
  'Announce',
  'Flag',
]);
const contentTypes = new Set(['Page', 'Article', 'Video', 'Note']);
const actorTypes = new Set(['Person', 'Group', 'Application', 'Service']);
/** Most activities one batched Announce (FEP-1a11) is read for. */
export const maxBatch = 200;

/** The few lookups a rewrite needs; the pipeline backs them with the database. */
export interface ClassifyEnv {
  /** Whether `apId` is a community on this server. */
  isLocalCommunity(apId: string): Promise<boolean>;
  /** The ap_id of the local follower whose Follow has this id, or null. */
  followerOf(followApId: string): Promise<string | null>;
  /** Whether a post or comment with this ap_id is stored here. */
  holds(apId: string): Promise<boolean>;
}

/**
 * One document to map and apply, or the reason there is nothing to do with it. `rewritten` is
 * set when the document is no longer what the peer sent (a Note made into a Page), so what is
 * relayed must be this document and not the bytes that arrived.
 */
export type Item = { json: JsonObject; rewritten?: true } | { skipped: Skipped };

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null =>
  typeof value === 'string' ? value : isObject(value) && typeof value.id === 'string' ? value.id : null;

/**
 * Whether `activity` is an Update that takes Public away from a post or comment we hold (the
 * object or the Update itself no longer addresses it). It goes on to its handler, which removes
 * our copy (handlers/_content.ts); refusing it here would leave the public copy as it was. An
 * Update of content we do not hold is refused here as before.
 */
async function withdrawsHeld(activity: JsonObject, env: ClassifyEnv): Promise<boolean> {
  if (activity.type !== 'Update' || notPublic(activity) === null) return false;
  const id = idOf(activity.object);
  return id !== null && (await env.holds(id));
}

/** The object of a Create or Update, rewritten or refused when it is not a plain Page or comment. */
async function contentObject(json: JsonObject, env: ClassifyEnv): Promise<Item> {
  const object = json.object;
  if (!isObject(object)) return { json };
  const type = object.type;
  if (type === 'Question') return { skipped: skip('type.question', idOf(object) ?? undefined) };
  if (typeof type !== 'string') return { json };
  if (json.type === 'Update' && actorTypes.has(type)) return { json };
  if (!contentTypes.has(type)) return { skipped: skip('object.unsupported', type) };
  // Before a Note is made a post: what is not public is not ours to store (visibility.ts).
  const hidden = notPublic(json);
  if (hidden && !(await withdrawsHeld(json, env))) return { skipped: hidden };
  if (type !== 'Note' || (object.inReplyTo !== undefined && object.inReplyTo !== null)) return { json };
  // A microblog post: only a community here makes it a post.
  for (const address of addressesOf(object)) {
    if (await env.isLocalCommunity(address)) return { json: { ...json, object: noteAsPage(object, address) }, rewritten: true };
  }
  return { skipped: skip('note.no_local_community', idOf(object) ?? undefined) };
}

/**
 * An Accept or Reject that names its Follow by IRI. A Reject gets the Follow embedded, as the
 * mapping reads it (core deletes only the follow with that id, and only on the followee's
 * word). An Accept is skipped: it must name the follower whose Follow it answers, and an IRI
 * does not (core's follow.accept checks the follower against the stored row).
 */
async function followAnswer(json: JsonObject, env: ClassifyEnv): Promise<Item> {
  if (typeof json.object !== 'string') return { json };
  if (json.type === 'Accept') return { skipped: skip('accept.unverifiable', json.object) };
  const follower = await env.followerOf(json.object);
  const answerer = idOf(json.actor);
  if (follower === null || answerer === null) return { skipped: skip('target.missing', json.object) };
  return { json: { ...json, object: { id: json.object, type: 'Follow', actor: follower, object: answerer } } };
}

async function classifyOne(json: unknown, env: ClassifyEnv, depth: number): Promise<Item> {
  if (!isObject(json)) throw new MappingError('a document is a JSON object');
  if (typeof json.type !== 'string') throw new MappingError('document has no type');
  if (!handledTypes.has(json.type)) return { skipped: skip('type.unhandled', json.type) };
  switch (json.type) {
    case 'Create':
    case 'Update':
      return contentObject(json, env);
    case 'Accept':
    case 'Reject':
      return followAnswer(json, env);
    case 'Announce': {
      const object = json.object;
      if (typeof object === 'string') return { skipped: skip('announce.bare_iri', object) };
      if (!isObject(object) || depth > 0) return { json };
      // Skipped before anything is read or fetched: an Announce that wraps an Announce can only chain origins.
      if (object.type === 'Announce') return { skipped: skip('announce.nested', idOf(object) ?? undefined) };
      if (typeof object.type === 'string' && handledTypes.has(object.type)) {
        const inner = await classifyOne(object, env, depth + 1);
        if (!('json' in inner)) return inner;
        // The Announce is one more layer that carries the content, and must be public too.
        const hidden = notPublic(inner.json, json);
        if (hidden && !(await withdrawsHeld(inner.json, env))) return { skipped: hidden };
        return { json: { ...json, object: inner.json }, ...(inner.rewritten && { rewritten: true as const }) };
      }
      // A bare Page or Note (the copy Lemmy sends Mastodon-like followers) is stored like its Create.
      if (typeof object.type === 'string' && contentTypes.has(object.type)) {
        const hidden = notPublic(object, json);
        if (hidden) return { skipped: hidden };
      }
      if (object.type === 'Question') return { skipped: skip('type.question', idOf(object) ?? undefined) };
      return { json };
    }
    default:
      return { json };
  }
}

/** The members of a batched Announce's object: an array, or an OrderedCollection or Collection of activities. */
function batchOf(object: unknown): unknown[] | null {
  if (Array.isArray(object)) return object;
  if (isObject(object) && (object.type === 'OrderedCollection' || object.type === 'Collection')) {
    const members = object.orderedItems ?? object.items;
    return Array.isArray(members) ? members : [];
  }
  return null;
}

/**
 * The documents to apply for one inbox body. Almost always one; PieFed's batched Announce
 * (FEP-1a11, parity matrix A11) carries many activities in one Announce, and each is applied
 * as an Announce of its own, so each dedupes by its own id.
 */
export async function classify(json: unknown, env: ClassifyEnv): Promise<Item[]> {
  if (isObject(json) && json.type === 'Announce') {
    const members = batchOf(json.object);
    if (members !== null) {
      if (members.length === 0) return [{ skipped: skip('announce.empty') }];
      return Promise.all(members.slice(0, maxBatch).map((member) => classifyOne({ ...json, object: member }, env, 0)));
    }
  }
  return [await classifyOne(json, env, 0)];
}
