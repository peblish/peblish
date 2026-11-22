import { DEFAULT_LOCALE } from '../../../i18n/negotiate.ts';
import type { MessageKey } from '../../../i18n/translate.ts';
import { ownTitle, pageTitle, rootTitleData } from '../../../shell/title.ts';
import feedCss from './feed.css?url';
import { feedPending } from './feed-pending.tsx';
import { loadFeed } from './load.ts';
import { depth, parseFeedSearch, resolveFeedSearch, type FeedSearch } from './search.ts';
import { askedNow } from './votes.ts';

// What the five feed routes share, so each route file is its path, its feed and its title.

export type FeedRoute = 'home' | 'local' | 'all' | 'popular' | 'moderating';

/**
 * A feed route's options: lenient search, the page's style and its loading host, and a loader keyed by the
 * sort, period and cursor, which reads as many rows as the address's `n` asks for. `n` is not a dep: the list
 * grows it in place as it loads more (replacing its own history entry), which must load nothing again; any
 * load of the entry (Back, Forward, a reload) reads that many. Such a load waits for the loader's answer
 * (`blocking`), as a first visit does, instead of drawing the router's kept copy while it reloads: no row
 * shows that the server has not just sent, and the router puts the scroll position back once they are all
 * there. The router's abort signal goes with the request, so a load the reader has left is given up.
 */
export function feedRoute(feed: FeedRoute, title?: MessageKey<'shell'>) {
  return {
    validateSearch: parseFeedSearch,
    loaderDeps: ({ search }: { search: FeedSearch }) => resolveFeedSearch(search),
    loader: {
      handler: async ({
        deps,
        location,
        abortController,
      }: {
        deps: ReturnType<typeof resolveFeedSearch>;
        location: { search: { n?: unknown } };
        abortController: AbortController;
      }) => {
        const asked = askedNow();
        const n = depth(location.search.n);
        const data = await loadFeed({
          data: { feed, sort: deps.sort, period: deps.period, ...(deps.cursor ? { cursor: deps.cursor } : {}), ...(n ? { n } : {}) },
          signal: abortController.signal,
        });
        // When it was asked for: a vote acknowledged after that may be missing from it (votes.ts).
        return { ...data, asked };
      },
      staleReloadMode: 'blocking' as const,
    },
    head: (context: { match: { status: string }; matches: readonly { routeId: string; loaderData?: unknown }[] }) => {
      const { locale, site } = rootTitleData(context.matches.find((match) => match.routeId === '__root__')?.loaderData, DEFAULT_LOCALE);
      return {
        // The home page keeps the shell's own title; the others are named for their feed.
        meta: ownTitle(context, title && pageTitle(locale, site, title)),
        links: [{ rel: 'stylesheet', href: feedCss }],
      };
    },
    pendingComponent: feedPending(feed),
    // The feed draws its own view header, with its name and the Sort and View menus (feed-page.tsx).
    staticData: { viewHeader: 'own' as const },
  };
}
