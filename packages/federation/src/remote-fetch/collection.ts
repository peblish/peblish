import { fetchActivity, type Fetcher } from '../actors/document.ts';
import type { JsonObject } from '../mapping/json.ts';

// Reading an ActivityPub collection a peer serves (a community's outbox or featured, a post's
// context): inline items, or a first page and its next pages. Peers differ here (Lemmy lists
// everything inline; others page), so both are read.

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

export type CollectionLimits = { pages: number; items: number };

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

/**
 * The items of `source` (a collection's IRI, or a collection a document embeds), at most
 * `limits.items`, following `first` and `next` up to `limits.pages` pages. A page link on
 * another origin than the collection's own is not followed. Throws FetchFailure when the first
 * fetch fails (a later page failing ends the read with what was read).
 */
export async function readCollection(source: unknown, fetch: Fetcher, limits: CollectionLimits): Promise<unknown[]> {
  const origin = (value: unknown): string | null => {
    const url = typeof value === 'string' ? value : isObject(value) ? value.id : undefined;
    return typeof url === 'string' && URL.canParse(url) ? new URL(url).origin : null;
  };
  const home = origin(source);
  const load = async (value: unknown): Promise<JsonObject | null> => {
    if (isObject(value)) return value;
    if (typeof value !== 'string') return null;
    return (await fetchActivity(value, fetch)).json as JsonObject | null;
  };

  const items: unknown[] = [];
  let node = await load(source);
  for (let page = 0; isObject(node) && page < limits.pages && items.length < limits.items; page++) {
    const here = listOf(node.orderedItems ?? node.items);
    items.push(...here.slice(0, limits.items - items.length));
    // A node with items of its own is a page; one without points at its first page.
    const link = 'orderedItems' in node || 'items' in node ? node.next : (node.first ?? node.next);
    if (link === undefined || (home !== null && origin(link) !== null && origin(link) !== home)) break;
    try {
      node = await load(link);
    } catch {
      break;
    }
  }
  return items;
}
