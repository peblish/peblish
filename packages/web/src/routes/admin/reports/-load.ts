import { readQueueByCommunity } from '@peblish/core/reports/groups';
import type { QueueSort } from '@peblish/core/reports/read';
import { queueTabs, type QueueTab } from '@peblish/core/reports/scope';
import { createServerFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { pageSession } from '../../../server/auth.ts';
import { input } from '../../../server/input.ts';

const Input = type({
  'tab?': 'string',
  'community?': 'string',
  'sort?': 'string',
  'cursor?': 'string',
});

const isTab = (value: string | undefined): value is QueueTab => queueTabs.some((tab) => tab === value);
const sorts: readonly QueueSort[] = ['oldest', 'newest', 'most'];
const isSort = (value: string | undefined): value is QueueSort => sorts.some((sort) => sort === value);

/** The queue's page data. Staff only: signed out is a redirect for the route, anyone else a 403 with no data. */
export const loadQueue = createServerFn({ method: 'GET' })
  .validator(input(Input))
  .handler(async ({ data }) => {
    const session = await pageSession();
    if (!session) return { access: 'signed-out' } as const;
    const viewer = { actorId: session.view.actorId, siteRole: session.view.siteRole };
    const tab = isTab(data.tab) ? data.tab : 'open';
    const sort = isSort(data.sort) ? data.sort : tab === 'resolved' || tab === 'dismissed' ? 'newest' : 'oldest';
    // `community` is an id or a handle (the sidebar and the community page link by handle); core resolves it among the viewer's own.
    const queue = await readQueueByCommunity(viewer, { tab, sort, community: data.community, cursor: data.cursor });
    if (!queue.ok) {
      setResponseStatus(403);
      return { access: 'denied', reason: queue.reason } as const;
    }
    return {
      access: 'ok',
      /** When the data was read: ages are counted from it, so the server and the browser print the same. */
      now: Date.now(),
      admin: viewer.siteRole === 'admin',
      tab,
      sort,
      // The communities, the chosen one, the rows by community and the next page, as core read them for this viewer.
      communities: queue.communities,
      community: queue.community,
      groups: queue.groups,
      next: queue.next,
    } as const;
  });
