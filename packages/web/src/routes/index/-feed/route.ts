import { DEFAULT_LOCALE } from '../../../i18n/negotiate.ts';
import type { MessageKey } from '../../../i18n/translate.ts';
import { pageTitle, rootTitleData } from '../../../shell/title.ts';
import feedCss from './feed.css?url';
import { loadFeed } from './load.ts';
import { parseFeedSearch, resolveFeedSearch, type FeedSearch } from './search.ts';

// What the five feed routes share, so each route file is its path, its feed and its title.

export type FeedRoute = 'home' | 'local' | 'all' | 'popular' | 'moderating';

/** A feed route's options: lenient search, a loader keyed by the whole address, and the page's style. */
export function feedRoute(feed: FeedRoute, title?: MessageKey<'shell'>) {
  return {
    validateSearch: parseFeedSearch,
    loaderDeps: ({ search }: { search: FeedSearch }) => resolveFeedSearch(search),
    loader: ({ deps }: { deps: ReturnType<typeof resolveFeedSearch> }) =>
      loadFeed({ data: { feed, sort: deps.sort, period: deps.period, ...(deps.cursor ? { cursor: deps.cursor } : {}) } }),
    head: ({ matches }: { matches: readonly { routeId: string; loaderData?: unknown }[] }) => {
      const { locale, site } = rootTitleData(matches.find((match) => match.routeId === '__root__')?.loaderData, DEFAULT_LOCALE);
      return {
        // The home page keeps the shell's own title; the others are named for their feed.
        meta: title ? [{ title: pageTitle(locale, site, title) }] : [],
        links: [{ rel: 'stylesheet', href: feedCss }],
      };
    },
  };
}
