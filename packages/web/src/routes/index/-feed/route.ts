import { DEFAULT_LOCALE } from '../../../i18n/negotiate.ts';
import type { MessageKey } from '../../../i18n/translate.ts';
import { FeedPending } from '../../../shell/pending.tsx';
import { ownTitle, pageTitle, rootTitleData } from '../../../shell/title.ts';
import feedCss from './feed.css?url';
import { loadFeed } from './load.ts';
import { parseFeedSearch, resolveFeedSearch, type FeedSearch } from './search.ts';

// What the five feed routes share, so each route file is its path, its feed and its title.

export type FeedRoute = 'home' | 'local' | 'all' | 'popular' | 'moderating';

/** A feed route's options: lenient search, a loader keyed by the whole address, the page's style and its loading rows. */
export function feedRoute(feed: FeedRoute, title?: MessageKey<'shell'>) {
  return {
    validateSearch: parseFeedSearch,
    loaderDeps: ({ search }: { search: FeedSearch }) => resolveFeedSearch(search),
    loader: ({ deps }: { deps: ReturnType<typeof resolveFeedSearch> }) =>
      loadFeed({ data: { feed, sort: deps.sort, period: deps.period, ...(deps.cursor ? { cursor: deps.cursor } : {}) } }),
    head: (context: { match: { status: string }; matches: readonly { routeId: string; loaderData?: unknown }[] }) => {
      const { locale, site } = rootTitleData(context.matches.find((match) => match.routeId === '__root__')?.loaderData, DEFAULT_LOCALE);
      return {
        // The home page keeps the shell's own title; the others are named for their feed.
        meta: ownTitle(context, title && pageTitle(locale, site, title)),
        links: [{ rel: 'stylesheet', href: feedCss }],
      };
    },
    pendingComponent: FeedPending,
    // The feed draws its own view header, with its name and the Sort and View menus (feed-page.tsx).
    staticData: { viewHeader: 'own' as const },
  };
}
