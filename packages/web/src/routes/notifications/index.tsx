import { unreadCap } from '@peblish/core/notifications/view';
import { createFileRoute } from '@tanstack/react-router';
import { DEFAULT_LOCALE } from '../../i18n/negotiate.ts';
import { ownTitle, pageTitle, rootTitleData } from '../../shell/title.ts';
import { privateResponses } from '../../server/auth.ts';
import { handleInboxPost } from './-form.ts';
import { loadInbox } from './-load.ts';
import { parseInboxSearch } from './-search.ts';
import { Inbox } from './-ui/inbox.tsx';
import inboxCss from './-ui/inbox.css?url';

// /notifications: the viewer's inbox (notifications-list). Signed out it answers 200 with a
// sign-in link and no data. The POST is the page's own form endpoint (-form.ts). Like /submit,
// the page carries the private-cache rule itself, since there is no layout above it.
export const Route = createFileRoute('/notifications/')({
  validateSearch: parseInboxSearch,
  loaderDeps: ({ search }) => ({ filter: search.filter ?? ('all' as const), cursor: search.cursor }),
  loader: ({ deps }) => loadInbox({ data: { filter: deps.filter, ...(deps.cursor ? { cursor: deps.cursor } : {}) } }),
  head: (context) => {
    const { matches, loaderData } = context;
    const all: readonly { routeId: string; loaderData?: unknown }[] = matches;
    const { locale, site } = rootTitleData(all.find((match) => match.routeId === '__root__')?.loaderData, DEFAULT_LOCALE);
    // "(3) Inbox · feddit.com": the unread count leads, as the badge does.
    const unread = loaderData?.signedIn ? loaderData.unread : 0;
    const count = unread >= unreadCap ? `${unreadCap - 1}+` : String(unread);
    return {
      meta: ownTitle(context, `${unread > 0 ? `(${count}) ` : ''}${pageTitle(locale, site, 'you.inbox')}`),
      links: [{ rel: 'stylesheet', href: inboxCss }],
    };
  },
  component: InboxRoute,
  // The page is personal: never from a shared cache (server/auth.ts).
  server: { middleware: [privateResponses], handlers: { POST: ({ request }) => handleInboxPost(request) } },
});

function InboxRoute() {
  return <Inbox data={Route.useLoaderData()} search={Route.useSearch()} />;
}
