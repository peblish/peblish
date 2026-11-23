import { readInbox } from '@peblish/core/notifications/read';
import { inboxFilters, type Inbox, type InboxItem } from '@peblish/core/notifications/view';
import { readSetting } from '@peblish/core/settings/read';
import { avatarInitial } from '@peblish/ui/components/avatar-initial.ts';
import { neutraliseBidi } from '@peblish/ui/components/handle';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../server/auth.ts';
import { input } from '../../server/input.ts';

/** A notice with the initial its row draws for whoever acted: made here, never in the browser (avatar-initial.ts). */
export type InboxNotice = InboxItem & { initial: string };

/**
 * The inbox page for the route loader (a server function: it runs on the server for a document
 * request and over fetch for a client-side navigation). Signed out it answers `signedIn: false`
 * with no data and runs no query. `now` is the clock the ages and the date groups are reckoned
 * against, so the server's text and the browser's hydrate the same. `contact` is the published
 * review address (`contact.email`, empty until the operator sets one), for a removal's review link.
 */
export const loadInbox = createServerFn({ method: 'GET' })
  .validator(input(type({ filter: type.enumerated(...inboxFilters), 'cursor?': 'string.uuid' })))
  .handler(async ({ data }) => {
    const session = await pageSession();
    const now = new Date().toISOString();
    if (!session) return { signedIn: false as const, now };
    const [inbox, contact]: [Inbox, string] = await Promise.all([
      readInbox({ actorId: session.view.actorId, siteRole: session.view.siteRole }, { filter: data.filter, cursor: data.cursor ?? null }),
      readSetting('contact.email'),
    ]);
    const items = inbox.items.map((item): InboxNotice => ({
      ...item,
      initial: avatarInitial(neutraliseBidi(item.actor?.handle ?? '', ''), '?'),
    }));
    return { signedIn: true as const, now, contact, ...inbox, items };
  });

export type InboxData = Awaited<ReturnType<typeof loadInbox>>;
