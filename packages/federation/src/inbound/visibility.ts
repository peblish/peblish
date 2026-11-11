import type { JsonObject } from '../mapping/json.ts';
import { isPublic } from '../mapping/vocabulary.ts';
import { skip, type Skipped } from './reasons.ts';

// peblish stores and relays public posts and comments only. A followers-only or direct Note (a
// Mastodon private or direct status that mentions a community here) would otherwise become a
// public post, announced to every follower of the community. One rule for every way a post or
// comment reaches us, checked before anything converts, stores or relays it: a Create or an
// Update, direct or inside an Announce (classify.ts), a bare object a community announces
// (classify.ts), the copy an announced object's origin serves (handlers/announce.ts), and an
// object fetched by id for the backfill, the missing-object job or a search
// (remote-fetch/object.ts storeObject, which the backfill hands the envelopes it unwrapped). Every layer that carries the object, the object itself
// included, must name Public in its `to` or `cc` (Mastodon's unlisted puts it in `cc`).

const contentTypes: ReadonlySet<string> = new Set(['Page', 'Article', 'Video', 'Note']);

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string');

/** Whether `document` names Public among its `to` and `cc`. */
export const addressedToPublic = (document: JsonObject): boolean => [...strings(document.to), ...strings(document.cc)].some(isPublic);

/**
 * `content.not_public` when `json` is a post or comment, or a Create or Update of one, that is
 * not addressed to Public, it or the activity around it; `envelopes` are the further layers it
 * came in (the community's Announce, or the Create, Update and Announce a backfilled collection
 * item was unwrapped from). Null for anything else (another activity, an actor, not an object),
 * which this rule does not concern.
 */
export function notPublic(json: unknown, ...envelopes: readonly JsonObject[]): Skipped | null {
  if (!isObject(json)) return null;
  const object = json.type === 'Create' || json.type === 'Update' ? json.object : json;
  if (!isObject(object) || typeof object.type !== 'string' || !contentTypes.has(object.type)) return null;
  const layers = [object, ...(object === json ? [] : [json]), ...envelopes];
  if (layers.every(addressedToPublic)) return null;
  return skip('content.not_public', typeof object.id === 'string' ? object.id : undefined);
}
