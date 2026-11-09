import { fetchActivity, FetchFailure, type Fetcher } from '../actors/document.ts';
import type { JsonObject } from '../mapping/json.ts';

// Reading an ActivityPub collection a peer serves (a community's outbox or featured, a post's
// context): inline items, or a first page and its next pages. Peers differ here (Lemmy lists
// everything inline; others page), so both are read.

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

export type CollectionLimits = { pages: number; items: number };

/** An item of a collection, and the origin of the document that carried it: where the bytes actually came from. */
export type CollectionItem = { item: unknown; origin: string };

/** Where a collection may be read from: every document read, the collection's `id`, `first` and each page, must be on one of `origins`. */
export type CollectionScope = {
  origins: readonly string[];
  /** The origin that served the document embedding `source`, when it is not an IRI. */
  servedFrom: string;
};

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

const isAllowed = (url: unknown, origins: readonly string[]): url is string =>
  typeof url === 'string' && URL.canParse(url) && origins.includes(new URL(url).origin);

/**
 * The items of `source` (a collection's IRI, or a collection a document embeds), at most
 * `limits.items`, following `first` and `next` up to `limits.pages` pages. A collection, page
 * link or page whose id is not on one of `scope.origins` is not read, whoever names it. Each
 * item comes with the origin of the document that carried it (an embedded node was served with
 * the document holding it, a fetched page by the origin it came from), so a caller can tell an
 * object embedded by its own server from one a third party typed in. Throws FetchFailure when
 * the first fetch fails, or `source` itself names another origin (a later page failing ends the
 * read with what was read).
 */
export async function readCollection(
  source: unknown,
  fetch: Fetcher,
  limits: CollectionLimits,
  scope: CollectionScope,
): Promise<CollectionItem[]> {
  type Node = { json: JsonObject; origin: string };
  const load = async (value: unknown, carrier: string): Promise<Node | null> => {
    // An embedded node came with its carrier's document; an id it carries must still be one we accept.
    if (isObject(value)) return value.id === undefined || isAllowed(value.id, scope.origins) ? { json: value, origin: carrier } : null;
    if (!isAllowed(value, scope.origins)) return null;
    const { json, url } = await fetchActivity(value, fetch);
    return isObject(json) && isAllowed(url, scope.origins) ? { json, origin: new URL(url).origin } : null;
  };

  const named = isObject(source) ? source.id : source;
  if (named !== undefined && !isAllowed(named, scope.origins)) throw new FetchFailure('blocked', 'the collection is on another server');
  const items: CollectionItem[] = [];
  let node = await load(source, scope.servedFrom);
  for (let page = 0; node && page < limits.pages && items.length < limits.items; page++) {
    const { json, origin } = node;
    for (const item of listOf(json.orderedItems ?? json.items).slice(0, limits.items - items.length)) items.push({ item, origin });
    // A node with items of its own is a page; one without points at its first page.
    const link = 'orderedItems' in json || 'items' in json ? json.next : (json.first ?? json.next);
    if (link === undefined) break;
    try {
      node = await load(link, origin);
    } catch {
      break;
    }
  }
  return items;
}
