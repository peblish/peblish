import { inboxFilters, isReadBatch, type InboxFilter } from '@peblish/core/notifications/view';
import { Uuid } from '@peblish/schema/ids';
import type { SearchSchemaInput } from '@tanstack/react-router';

// The inbox's address: /notifications?filter=unread&cursor=<id>&error=<reason>. Every part is
// optional and one that is not valid is dropped, so a stale or hand-edited link still opens the
// inbox. Defaults are applied after parsing and never written into the address. After Mark all
// read the address also says how many it marked and the stamp its Undo takes (`marked`, `batch`),
// and after the Undo how many came back (`restored`, 0 when another tab undid it first), so the
// page shows the same status row with scripts and without.

export type InboxSearch = {
  filter?: InboxFilter | undefined;
  cursor?: string | undefined;
  error?: string | undefined;
  marked?: number | undefined;
  /** Mark all read's stamp, as a number: the router writes a string of digits back into the address in quotes. */
  batch?: number | undefined;
  restored?: number | undefined;
};

const isFilter = (value: unknown): value is InboxFilter => inboxFilters.some((filter) => filter === value);

/** A count in the address, 0 included: the router may already have read it as a number. */
function countOf(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^(0|[1-9][0-9]{0,5})$/.test(text) ? Number(text) : undefined;
}

/** A stamp in the address, whether the router read it as a number or not (microseconds stay exact as one until 2255). */
function batchOf(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && isReadBatch(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
}

/** Mark all read's status row: its count and stamp come together or not at all, as an Undo needs both, and something marked. */
export function markedRow(marked: unknown, batch: unknown): Pick<InboxSearch, 'marked' | 'batch'> {
  const count = countOf(marked);
  const stamp = batchOf(batch);
  const both = count !== undefined && count > 0 && stamp !== undefined;
  return { marked: both ? count : undefined, batch: both ? stamp : undefined };
}

export function parseInboxSearch(
  raw: { filter?: unknown; cursor?: unknown; error?: unknown; marked?: unknown; batch?: unknown; restored?: unknown } & SearchSchemaInput,
): InboxSearch {
  return {
    filter: isFilter(raw.filter) ? raw.filter : undefined,
    cursor: typeof raw.cursor === 'string' && Uuid.allows(raw.cursor) ? raw.cursor : undefined,
    // A reason code ("target.not_found"); the page maps the ones it knows and shows a general message for the rest.
    error: typeof raw.error === 'string' && raw.error.length > 0 && raw.error.length <= 60 ? raw.error : undefined,
    ...markedRow(raw.marked, raw.batch),
    restored: countOf(raw.restored),
  };
}

/** The address of the inbox with a filter and a page; what is default is left out. */
export function inboxHref({ filter, cursor, error, marked, batch, restored }: InboxSearch = {}): string {
  const params = new URLSearchParams();
  if (filter && filter !== 'all') params.set('filter', filter);
  if (cursor) params.set('cursor', cursor);
  if (error) params.set('error', error);
  if (marked && batch) {
    params.set('marked', String(marked));
    params.set('batch', String(batch));
  }
  if (restored !== undefined) params.set('restored', String(restored));
  const query = params.toString();
  return query ? `/notifications?${query}` : '/notifications';
}

export type InboxIntent =
  | { intent: 'read' | 'unread'; id: string }
  | { intent: 'read_all' }
  /** `marked` rides along so that a refused Undo goes back to its status row (-form.ts). */
  | { intent: 'undo_read_all'; batch: string; marked?: number };

/**
 * Where an inbox form posts: the intent, the notice and the page to come back to ride in the
 * address, so the form needs only its submit button (-form.ts reads the address and the body).
 */
export function inboxAction(what: InboxIntent, { filter, cursor }: InboxSearch = {}): string {
  const params = new URLSearchParams({ intent: what.intent });
  if (what.intent === 'read' || what.intent === 'unread') params.set('id', what.id);
  if (what.intent === 'undo_read_all') {
    params.set('batch', what.batch);
    if (what.marked) params.set('marked', String(what.marked));
  }
  if (filter && filter !== 'all') params.set('filter', filter);
  if (cursor) params.set('cursor', cursor);
  return `/notifications?${params.toString()}`;
}

/** Where Follow thread and Unfollow post (a post's page, without scripts too): the inbox's endpoint, which answers back to the post. */
export const watchAction = (intent: 'watch' | 'unwatch', postId: string): string =>
  `/notifications?${new URLSearchParams({ intent, post: postId }).toString()}`;
