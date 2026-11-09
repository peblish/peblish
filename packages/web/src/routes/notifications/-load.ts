import { readInbox } from '@peblish/core/notifications/read';
import { inboxFilters, type Inbox } from '@peblish/core/notifications/view';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../server/auth.ts';

/**
 * The inbox page for the route loader (a server function: it runs on the server for a document
 * request and over fetch for a client-side navigation). Signed out it answers `signedIn: false`
 * with no data and runs no query. `now` is the clock the ages are printed against, so the
 * server's text and the browser's hydrate the same.
 */
export const loadInbox = createServerFn({ method: 'GET' })
  .validator(type({ filter: type.enumerated(...inboxFilters), 'cursor?': 'string.uuid' }))
  .handler(async ({ data }) => {
    const session = await pageSession();
    const now = new Date().toISOString();
    if (!session) return { signedIn: false as const, now };
    const inbox: Inbox = await readInbox(
      { actorId: session.view.actorId, siteRole: session.view.siteRole },
      { filter: data.filter, cursor: data.cursor ?? null },
    );
    return { signedIn: true as const, now, ...inbox };
  });

export type InboxData = Awaited<ReturnType<typeof loadInbox>>;
