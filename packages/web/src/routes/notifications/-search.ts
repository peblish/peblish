import { inboxFilters, type InboxFilter } from '@peblish/core/notifications/view';
import { Uuid } from '@peblish/schema/ids';
import type { SearchSchemaInput } from '@tanstack/react-router';

// The inbox's address: /notifications?filter=unread&cursor=<id>&error=<reason>. Every part is
// optional and one that is not valid is dropped, so a stale or hand-edited link still opens the
// inbox. Defaults are applied after parsing and never written into the address.

export type InboxSearch = { filter?: InboxFilter | undefined; cursor?: string | undefined; error?: string | undefined };

const isFilter = (value: unknown): value is InboxFilter => inboxFilters.some((filter) => filter === value);

export function parseInboxSearch(raw: { filter?: unknown; cursor?: unknown; error?: unknown } & SearchSchemaInput): InboxSearch {
  return {
    filter: isFilter(raw.filter) ? raw.filter : undefined,
    cursor: typeof raw.cursor === 'string' && Uuid.allows(raw.cursor) ? raw.cursor : undefined,
    // A reason code ("target.not_found"); the page maps the ones it knows and shows a general message for the rest.
    error: typeof raw.error === 'string' && raw.error.length > 0 && raw.error.length <= 60 ? raw.error : undefined,
  };
}

/** The address of the inbox with a filter and a page; what is default is left out. */
export function inboxHref({ filter, cursor, error }: InboxSearch = {}): string {
  const params = new URLSearchParams();
  if (filter && filter !== 'all') params.set('filter', filter);
  if (cursor) params.set('cursor', cursor);
  if (error) params.set('error', error);
  const query = params.toString();
  return query ? `/notifications?${query}` : '/notifications';
}

export type InboxIntent = { intent: 'read' | 'unread'; id: string } | { intent: 'read_all' };

/**
 * Where an inbox form posts: the intent, the notice and the page to come back to ride in the
 * address, so the form needs only its submit button (-form.ts reads the address and the body).
 */
export function inboxAction(what: InboxIntent, { filter, cursor }: InboxSearch = {}): string {
  const params = new URLSearchParams({ intent: what.intent });
  if (what.intent !== 'read_all') params.set('id', what.id);
  if (filter && filter !== 'all') params.set('filter', filter);
  if (cursor) params.set('cursor', cursor);
  return `/notifications?${params.toString()}`;
}
