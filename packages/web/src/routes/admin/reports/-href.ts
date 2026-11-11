import type { QueueTab } from '@peblish/core/reports/scope';

// The queue's addresses, in a module with no component: the route's loader uses queueHref, and a
// loader stays in the client entry (see `auth/-route.ts`).

/** The queue's own address with the tab, community and sort the viewer chose, for links and for where a form returns. */
export type QueueView = {
  tab: QueueTab;
  community: string | null;
  sort: string;
  cursor?: string | null;
  /** The group whose quote is shown. */
  show?: string | null;
  /** The group whose reporters and details are shown. */
  details?: string | null;
  /** The group whose Remove form the server renders open, for its link without scripts. */
  remove?: string | null;
};

export const queueHref = (view: QueueView, change: Partial<QueueView> = {}) => {
  const next = { ...view, ...change };
  const params = new URLSearchParams();
  if (next.tab !== 'open') params.set('tab', next.tab);
  if (next.community) params.set('community', next.community);
  params.set('sort', next.sort);
  if (next.cursor) params.set('cursor', next.cursor);
  if (next.show) params.set('show', next.show);
  if (next.details) params.set('details', next.details);
  if (next.remove) params.set('remove', next.remove);
  return `/admin/reports?${params}`;
};
