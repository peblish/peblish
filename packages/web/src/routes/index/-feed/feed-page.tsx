import type { FeedName, Period, Sort } from '@peblish/core/feeds/input';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { defaultPageSize, defaultPeriod, defaultSort, maxDepth, periods, sorts } from '@peblish/core/feeds/input';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { FactList } from '@peblish/ui/components/fact-list';
import { FeedEnd, FeedSkip, type FeedEndState } from '@peblish/ui/components/feed-end';
import { SortMenu, ViewMenu, type MenuChoice } from '@peblish/ui/components/feed-menus';
import { FeedRowActions } from '@peblish/ui/components/feed-row-actions';
import {
  FlameIcon,
  GlobeIcon,
  HouseIcon,
  MapPinIcon,
  ShieldIcon,
  SortNewIcon,
  SortOldIcon,
  SortTopIcon,
  ViewCardIcon,
  ViewClassicIcon,
  ViewCompactIcon,
  type IconProps,
} from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Pager } from '@peblish/ui/components/pager';
import { PostRow, type Density } from '@peblish/ui/components/post-row';
import { RailPanel } from '@peblish/ui/components/rail-panel';
import { Text } from '@peblish/ui/components/text';
import { useToast } from '@peblish/ui/components/toast';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { FeedSkeleton } from '@peblish/ui/skeleton/skeletons';
import { DensityControl, densities } from '@peblish/ui/density/density-control';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { openInRouter } from '../../../shell/client-links.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { useDensityLabels, usePostCardLabels } from '../../../shell/labels.ts';
import { communityPath, directoryPaths, feedPaths, postPath, userPath } from '../../../shell/paths.ts';
import { usePrefs } from '../../../shell/prefs.tsx';
import { Rail } from '../../../shell/rail.tsx';
import { ViewHeader } from '../../../shell/view-header.tsx';
import { castVoteFn } from '../../post/-vote.ts';
import { useRowSave } from '../../saved/-ui/use-row-save.ts';
import type { FeedItem } from './items.ts';
import { loadFeed, type FeedData } from './load.ts';
import { feedTitleKeys } from './names.ts';
import { dropPlace, keepPlace, scrolledSinceTraversal, takePlace } from './places.ts';
import { grow, isGrowth, isReading, noReads, readsNow, subscribeReads } from './reads.ts';
import type { FeedRoute } from './route.ts';
import { depth, feedHref, resolveFeedSearch, type FeedPosition, type FeedSearch } from './search.ts';
import { acknowledgedVotes, acknowledgeVote, askedNow, noVotes, subscribeVotes, withVotes } from './votes.ts';

// A feed (Commons): its own view header with the feed's name and the Sort and View menus (with scripts
// off, the sort and Top period as LinkTabs instead), the posts, which load their next batch by
// themselves as the reader nears the end, and the rail. FeedToolbar and FeedCards are the parts for
// other pages that list posts (a community page, a profile); FeedCards takes the auto-load (`more`)
// and the rows' Share and Copy link (`rowActions`) only when asked, and is otherwise as it was.

const root = getRouteApi('__root__');

const feedIcons: Record<FeedName, ComponentType<IconProps>> = {
  subscribed: HouseIcon,
  local: MapPinIcon,
  all: GlobeIcon,
  popular: FlameIcon,
  moderating: ShieldIcon,
};

const sortIcons: Record<Sort, ComponentType<IconProps>> = { hot: FlameIcon, new: SortNewIcon, old: SortOldIcon, top: SortTopIcon };
const viewIcons: Record<Density, ComponentType<IconProps>> = { card: ViewCardIcon, classic: ViewClassicIcon, compact: ViewCompactIcon };

export function FeedPage({ path, data, search }: { path: string; data: FeedData & { asked: number }; search: FeedSearch }) {
  useRouteHydrated();
  const feed = feedOf(path);
  const { sort, period } = resolveFeedSearch(search);
  const more = useMemo<FeedMore>(
    () => ({
      load: (cursor, signal) =>
        loadFeed({ data: { feed, sort, period, cursor }, signal }).then(({ items, next, now }) => ({ items, next, now })),
    }),
    [feed, sort, period],
  );
  return (
    <>
      <main className="pb-page feed" data-feed={data.feed}>
        <FeedHeader path={path} feed={data.feed} search={search} />
        <FeedCards path={path} data={data} search={search} empty={<Empty feed={data.feed} />} more={more} rowActions />
      </main>
      <FeedRail feed={data.feed} />
    </>
  );
}

/** Which of the five routes a feed page is, from its path (the home page is Subscribed or Local by viewer). */
const feedOf = (path: string): FeedRoute =>
  path === feedPaths.all
    ? 'all'
    : path === feedPaths.local
      ? 'local'
      : path === feedPaths.popular
        ? 'popular'
        : path === feedPaths.moderating
          ? 'moderating'
          : 'home';

/**
 * The feed's view header: its glyph and name (the page's h1), then Sort (with Top's period) and View
 * as Mux menus, which need scripts and are disabled until the page has hydrated. With scripts off
 * (`scripting: none`, feed.css) the menus give way to the sort and period as plain links under the bar.
 */
function FeedHeader({ path, feed, search: address }: { path: string; feed: FeedName; search: FeedSearch }) {
  const search = resolveFeedSearch(address);
  const { t } = useTranslate();
  const router = useRouter();
  const hydrated = useHydrated();
  const { prefs, setPrefs } = usePrefs();
  const densityLabels = useDensityLabels();
  const Icon = feedIcons[feed];
  const sortChoices: MenuChoice<Sort>[] = sorts.map((id) => ({ id, label: t('feeds', `sort.${id}`), icon: sortIcons[id] }));
  const periodChoices: MenuChoice<Period>[] = periods.map((id) => ({ id, label: t('feeds', `period.${id}`) }));
  const viewChoices: MenuChoice<Density>[] = densities.map((id) => ({ id, label: densityLabels[id], icon: viewIcons[id] }));
  const sortName = t('feeds', `sort.${search.sort}`);
  const setDensity = (density: Density) => setPrefs({ density });
  const sortProps = {
    sorts: sortChoices,
    sort: search.sort,
    periodSort: 'top' as const,
    periods: periodChoices,
    period: search.period,
    labels: {
      group: t('feeds', 'sort.group'),
      periodGroup: t('feeds', 'period.group'),
      current: t('feeds', 'menu.current'),
      trigger:
        search.sort === 'top'
          ? t('feeds', 'header.sortTop', { period: t('feeds', `period.${search.period}`) })
          : t('feeds', 'header.sort', { sort: sortName }),
    },
    // The sort (and period) already chosen changes nothing: the address keeps its `n`, the list its rows.
    // Another one is another list, from its first batch.
    onChange: (sort: Sort, period = search.period) => {
      if (sort === search.sort && (sort !== 'top' || period === search.period)) return;
      openInRouter(router, feedHref(path, { sort, period }));
    },
    disabled: !hydrated,
  };
  return (
    <>
      <ViewHeader
        root
        title={
          <span className="feed-name">
            <Icon className="feed-name__icon" />
            <Text as="h1" variant="label" truncate className="pb-frame-vh__title feed-title">
              {t('shell', feedTitleKeys[feed])}
            </Text>
          </span>
        }
        trailing={
          <span className="feed-menus">
            <SortMenu {...sortProps} className="feed-menus__wide" />
            <ViewMenu
              views={viewChoices}
              view={prefs.density}
              labels={{
                group: densityLabels.group,
                current: t('feeds', 'menu.current'),
                trigger: t('feeds', 'header.view', { view: densityLabels[prefs.density] }),
              }}
              onChange={setDensity}
              disabled={!hydrated}
              className="feed-menus__wide"
            />
            {/* A phone's bar with the site's name has room for one menu: Sort holds the views too (feed.css). */}
            <SortMenu
              {...sortProps}
              labels={{
                ...sortProps.labels,
                trigger: t('feeds', 'header.sortView', { sort: sortProps.labels.trigger, view: densityLabels[prefs.density] }),
              }}
              viewSection={{ title: densityLabels.group, views: viewChoices, view: prefs.density, onChange: setDensity }}
              className="feed-menus__narrow"
            />
          </span>
        }
      />
      <div className="feed-no-script">
        <SortLinks path={path} search={search} shown={feedHref(path, { ...search, n: address.n })} />
      </div>
    </>
  );
}

/**
 * The sort and, for Top, its period as LinkTabs: real links, which work before hydration and without scripts. With
 * `shown` (a feed's own address, its page and depth `n` kept), the one already chosen leads there, so following it
 * changes nothing and adds no history entry; another is another list, from its first batch.
 */
function SortLinks({ path, search, shown }: { path: string; search: ReturnType<typeof resolveFeedSearch>; shown?: string }) {
  const { t } = useTranslate();
  return (
    <>
      <LinkTabs
        aria-label={t('feeds', 'sort.group')}
        className="feed-tabs"
        variant="segment"
        size="sm"
        items={sorts.map((value: Sort) => ({
          to: (search.sort === value && shown) || feedHref(path, { ...search, sort: value, cursor: undefined }),
          label: t('feeds', `sort.${value}`),
          active: search.sort === value,
        }))}
      />
      {search.sort === 'top' && (
        <LinkTabs
          aria-label={t('feeds', 'period.group')}
          className="feed-tabs"
          variant="segment"
          size="sm"
          items={periods.map((value: Period) => ({
            to: (search.period === value && shown) || feedHref(path, { sort: 'top', period: value }),
            label: t('feeds', `period.${value}`),
            active: search.period === value,
          }))}
        />
      )}
    </>
  );
}

/**
 * The sort and Top period as links to `path`, and the density switch. `children` come first in
 * the bar (a feed's heading). For any page that lists posts the feed way (a community, a profile).
 */
export function FeedToolbar({ path, search: address, children }: { path: string; search: FeedSearch; children?: ReactNode }) {
  const search = resolveFeedSearch(address);
  const { prefs, setPrefs } = usePrefs();
  const densityLabels = useDensityLabels();
  return (
    <div className="feed-toolbar">
      {children}
      <SortLinks path={path} search={search} />
      <span className="feed-space" />
      <DensityControl value={prefs.density} onChange={(density) => setPrefs({ density })} labels={densityLabels} />
    </div>
  );
}

/**
 * What the cards need of a page's data: the posts, the clock their ages print against, the next cursor; and
 * from a feed's loader, how many rows it read (`n`) and when it was asked for (`asked`, votes.ts).
 */
export type FeedCardsData = Pick<FeedData, 'items' | 'next' | 'now' | 'signedIn'> & { signIn?: boolean; n?: number; asked?: number };

/** A batch as the list's loader answers it. */
export interface Batch {
  items: readonly FeedItem[];
  next: string | null;
  now: string;
}

/** Auto-load for FeedCards: `load` reads the batch after a cursor, until its signal aborts. */
export interface FeedMore {
  load: (cursor: string, signal: AbortSignal) => Promise<Batch>;
}

/** A row and the clock its age prints against (the server's, for the answer it came with). */
type Row = FeedItem & { now: string };

/** The list beyond its page's data: the batches loaded after it (each with when it was asked for), and the next one's state. */
interface Loaded {
  data: FeedCardsData;
  batches: readonly (Batch & { asked: number })[];
  next: string | null;
  state: 'idle' | 'pending' | 'failed';
  /** What the list's status last said: once per batch, emptied while the next one loads. */
  said: string;
}

const loadedFrom = (data: FeedCardsData): Loaded => ({ data, batches: [], next: data.next, state: 'idle', said: '' });

/**
 * Whether a location is still the list's own (path, sort, period, first cursor; `n` aside). The router's latest
 * location is the next page's as soon as the reader heads there, while the list is still on screen.
 */
const sameList = (
  path: string,
  list: FeedPosition,
  { pathname, search }: { pathname: string; search: { sort?: unknown; period?: unknown; cursor?: unknown } },
) =>
  pathname === path &&
  (search.sort ?? defaultSort) === list.sort &&
  (search.period ?? defaultPeriod) === list.period &&
  search.cursor === list.cursor;

/** What a focus target after the list can be (Skip past the posts looks for the first one). */
const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The posts as cards and the links to the first and next page, under `path`. `empty` shows when
 * there are no posts; a Moderating feed without a viewer (`signIn`) asks to sign in instead.
 *
 * With `more`, once the page has hydrated the next batch loads by itself when the end of the list is
 * within a screen (an IntersectionObserver on a sentinel after the rows): skeleton rows in the current
 * density while it loads, a Retry row (beside the real next-page link) when it fails, and the end line
 * when there is no more. One polite status per list says what each batch did. Skip past the posts, at
 * the list's start, moves focus to what follows the list. Before hydration, without scripts or without
 * IntersectionObserver the next page stays a plain link. The page draws what its loader answered, then
 * the batches it loads after it; after each, the list writes how many rows it has read into its own
 * history entry's address (`n`, search.ts), so Back, Forward or a reload reads them fresh, in one answer;
 * the row the reader opened a post from goes back where it stood (places.ts), else the scroll position does.
 * Nothing of the rows is kept anywhere else.
 * With `rowActions`, each row gets Share (the system's share sheet where there is one, else the link is
 * copied) and a menu with Copy link.
 */
export function FeedCards({
  path,
  data,
  search: address,
  empty,
  more,
  rowActions = false,
}: {
  path: string;
  data: FeedCardsData;
  search: FeedSearch;
  empty: ReactNode;
  more?: FeedMore;
  rowActions?: boolean;
}) {
  const search = resolveFeedSearch(address);
  const { t, locale } = useTranslate();
  const { prefs } = usePrefs();
  const hydrated = useHydrated();
  const router = useRouter();
  const voteFailed = useVoteFailedToast();
  // A new answer from the loader (a load of this entry, another sort or feed) is the list again.
  const [list, setList] = useState(() => loadedFrom(data));
  if (list.data !== data) setList(loadedFrom(data));
  const auto = more !== undefined && hydrated && typeof IntersectionObserver !== 'undefined';
  // A read of this very list is out (a return to it): none of the rows from before are drawn until its answer is the data.
  const reads = useSyncExternalStore(subscribeReads, readsNow, noReads);
  const reading = more !== undefined && isReading(reads, path, search, data.asked ?? Number.POSITIVE_INFINITY);

  // Each answer's rows in order, a post an earlier one holds left out (a ranking can move a post across a
  // cursor), each with a vote acknowledged since it was asked for. Without `asked` (a community page) the
  // answer stands as it came.
  const votes = useSyncExternalStore(subscribeVotes, acknowledgedVotes, noVotes);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const answer of [{ ...data, asked: data.asked ?? Number.POSITIVE_INFINITY }, ...list.batches])
      for (const item of withVotes(votes, answer.items, answer.asked))
        if (!seen.has(item.post.id)) {
          seen.add(item.post.id);
          out.push({ ...item, now: answer.now });
        }
    return out;
  }, [data, list.batches, votes]);

  const box = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const messages = {
    loaded: (count: number, last: boolean) =>
      `${translatePlural(locale, 'feeds', 'more.loaded', count)}${last ? ` ${t('feeds', 'end')}` : ''}`,
    failed: t('feeds', 'more.failed'),
  };
  // What the observer and Retry read when they fire: this render's list, not the one they were made in.
  const latest = useRef({ list, rows, more, messages, search, reading });
  useLayoutEffect(() => {
    latest.current = { list, rows, more, messages, search, reading };
  });
  // The batch on its way: a new answer from the loader, or leaving the page, gives it up.
  const asking = useRef<AbortController | null>(null);
  useEffect(() => () => asking.current?.abort(), [data]);
  // The rows' generation. Any departure but the list's own growth of `n` ends one: a router navigation (a return
  // to the list, another sort or feed, the reader leaving) or the document's own (a full page load, the browser's
  // Back to another document). The batch on its way is given up, and after a navigation none starts until its
  // answer is the list's data, which opens the next. A batch answers into its own generation or not at all, so one
  // that answers late draws nothing, writes no depth (a write by a leaving page can even cancel its Back) and
  // cannot cut the read of a return short.
  const generation = useRef({ at: 0, open: true });
  useLayoutEffect(() => {
    generation.current = { at: generation.current.at + 1, open: true };
  }, [data]);
  const endGeneration = useCallback(
    (open: boolean) => {
      generation.current = { at: generation.current.at + 1, open };
      asking.current?.abort();
      setList((now) => (now.state === 'pending' ? { ...now, state: 'idle', said: '' } : now));
    },
    [setList],
  );
  useLayoutEffect(() => {
    if (!more) return;
    const ending = router.subscribe('onBeforeLoad', ({ toLocation }) => {
      const { search } = latest.current;
      const { n }: { n?: unknown } = toLocation.search;
      if (sameList(path, search, toLocation) && isGrowth(path, search, depth(n) ?? defaultPageSize)) return;
      endGeneration(false);
    });
    // A navigation that lands on the list without a new answer for it (none is known; every return reads again)
    // must not leave it closed.
    const resolved = router.subscribe('onResolved', ({ toLocation }) => {
      if (sameList(path, latest.current.search, toLocation)) generation.current = { ...generation.current, open: true };
    });
    // The document hidden on the way out, and shown again from the back-forward cache: a new generation, so a batch
    // from before draws nothing there. A tab merely hidden fires neither.
    const hidden = () => endGeneration(false);
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) generation.current = { at: generation.current.at + 1, open: true };
    };
    addEventListener('pagehide', hidden);
    addEventListener('pageshow', shown);
    return () => {
      ending();
      resolved();
      removeEventListener('pagehide', hidden);
      removeEventListener('pageshow', shown);
    };
  }, [more, path, router, endGeneration]);
  const next = useCallback(() => {
    const { list, rows, more, messages, search, reading } = latest.current;
    // Nothing while a batch or the list's own read loads, at the end, or once the router is on its way to another page.
    if (!more || reading || !generation.current.open || list.state === 'pending' || list.next === null) return;
    if (!sameList(path, search, router.latestLocation)) return;
    const stop = new AbortController();
    asking.current = stop;
    const { at } = generation.current;
    const current = () => !stop.signal.aborted && generation.current.at === at;
    const asked = askedNow();
    setList({ ...list, state: 'pending', said: '' });
    const same = (now: Loaded) => now.data === list.data;
    // The document's own way out starts well before it is hidden (the browser's Back to another document waits for
    // that document): while this batch is out, that start gives it up, and no other starts on the way out (the end
    // may still be in view). Listened for only then, so the page stays fit for the back-forward cache. A way out
    // that is stopped leaves the list closed until its next navigation or a showing from the back-forward cache.
    const leaving = () => endGeneration(false);
    addEventListener('beforeunload', leaving);
    void more
      .load(list.next, stop.signal)
      .then(
        (batch) => {
          if (!current()) return;
          const shown = new Set(rows.map((row) => row.post.id));
          const said = messages.loaded(batch.items.filter((item) => !shown.has(item.post.id)).length, batch.next === null);
          setList((now) =>
            same(now) ? { ...now, batches: [...now.batches, { ...batch, asked }], next: batch.next, state: 'idle', said } : now,
          );
        },
        () => {
          if (current()) setList((now) => (same(now) ? { ...now, state: 'failed', said: messages.failed } : now));
        },
      )
      .finally(() => removeEventListener('beforeunload', leaving));
  }, [path, router, setList, endGeneration]);
  // After each batch the list's own history entry says how many rows it has read (`n`, at most 200), replaced in
  // place: no new entry, no scroll, and no load (`n` is not one of the loader's deps, and the route reads nothing
  // again for the list's own growth, reads.ts).
  const batches = list.batches.length;
  const read = Math.min(maxDepth, (data.n ?? defaultPageSize) + batches * defaultPageSize);
  const written = address.n ?? defaultPageSize;
  useEffect(() => {
    const { search } = latest.current;
    if (batches === 0 || read === written || !generation.current.open || !sameList(path, search, router.latestLocation)) return;
    const grown = grow(path, search, read);
    void router.navigate({ href: feedHref(path, { ...search, n: read }), replace: true, resetScroll: false }).finally(grown);
  }, [batches, read, written, path, router]);

  // The row the reader leaves the list from for a post, and back to it once a return through the router has drawn
  // the fresh rows: after the router's own restore, in the same task, once (places.ts). A place is kept only when a
  // navigation to a post starts from the reader activating a link in a row in this tab (a click, a tap or Enter,
  // with no modifier key), and it names that row wherever the link leads (a card's link to another post). The router
  // starts a link's navigation inside the click's own dispatch, so the activation is held for that task alone: a
  // click that starts no navigation there (one the page prevented) leaves nothing behind. Any other way off the list
  // (Back, Forward, the frame's links, a sort) keeps no place, and the router alone puts the window back; so it does
  // on a document's first render, when the row is not among the fresh rows, and when the reader scrolls on the way.
  useLayoutEffect(() => {
    const list = box.current;
    if (!more || !list) return;
    const entryOf = (location: { href: string; state: { __TSR_key?: string } }) => location.state.__TSR_key ?? location.href;
    const rowOf = (post: string) => box.current?.querySelector(`.feed-list > li[data-post="${CSS.escape(post)}"]`) ?? null;
    let activation: { row: string; to: string } | null = null;
    const activate = (event: MouseEvent) => {
      activation = null;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      const row = link?.closest<HTMLElement>('.feed-list > li[data-post]')?.dataset.post;
      const here = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
      if (!here || !(link instanceof HTMLAnchorElement) || !row || link.origin !== location.origin || link.target) return;
      const held = { row, to: link.pathname };
      activation = held;
      // The click's task is over: a navigation it started has begun by now, and one it did not start never will.
      setTimeout(() => {
        if (activation === held) activation = null;
      });
    };
    // Captured on the list, before the router's link handler starts the navigation.
    list.addEventListener('click', activate, true);
    const leaving = router.subscribe('onBeforeLoad', ({ fromLocation, toLocation }) => {
      const activated = activation;
      activation = null;
      const { search, reading } = latest.current;
      if (!fromLocation || reading || !sameList(path, search, fromLocation) || sameList(path, search, toLocation)) return;
      const opens = activated && /^\/post\/[^/]+$/.test(toLocation.pathname) && toLocation.pathname === activated.to;
      const row = opens ? rowOf(activated.row) : null;
      if (activated && row) keepPlace(entryOf(fromLocation), { post: activated.row, offset: row.getBoundingClientRect().top });
      else dropPlace(entryOf(fromLocation));
    });
    const arriving = router.subscribe('onRendered', ({ fromLocation, toLocation }) => {
      const { search, reading } = latest.current;
      if (!sameList(path, search, toLocation)) return;
      // Taken whatever follows, so it acts once at most. A document's first render comes from its own entry.
      const place = takePlace(entryOf(toLocation));
      const returned = fromLocation !== undefined && entryOf(fromLocation) !== entryOf(toLocation);
      const row = place && returned && !reading && !scrolledSinceTraversal() ? rowOf(place.post) : null;
      if (place && row) window.scrollTo({ top: scrollY + row.getBoundingClientRect().top - place.offset, behavior: 'instant' });
    });
    return () => {
      list.removeEventListener('click', activate, true);
      leaving();
      arriving();
    };
  }, [more, path, router]);

  // The observer lives with the sentinel, which mounts again after every batch, so it reports at once
  // whether the end is still near. Its margin is one screen below the window.
  const sentinel = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && next(), { rootMargin: '0px 0px 100% 0px' });
      observer.observe(element);
      return () => observer.disconnect();
    },
    [next],
  );

  // Retry parks focus on the list's end while the batch loads, then moves it to the first new post's
  // title, or back to Retry if it failed again, but only if the reader has not moved it meanwhile.
  const retried = useRef<number | null>(null);
  const retry = () => {
    retried.current = rows.length;
    end.current?.focus({ preventScroll: true });
    next();
  };
  useEffect(() => {
    const from = retried.current;
    if (from === null || list.state === 'pending') return;
    retried.current = null;
    if (document.activeElement !== end.current) return;
    const target =
      list.state === 'failed'
        ? end.current?.querySelector<HTMLElement>('button')
        : box.current?.querySelectorAll('.feed-list > li')[from]?.querySelector<HTMLElement>('.pb-post__title a[href]');
    target?.focus();
  }, [list.state, rows.length]);

  const skip = () => {
    const list = box.current;
    if (!list) return;
    const after = [...document.querySelectorAll<HTMLElement>(focusable)].find(
      (element) =>
        !list.contains(element) && list.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING && element.checkVisibility(),
    );
    (after ?? end.current)?.focus();
  };

  const state: FeedEndState = list.next === null ? 'end' : list.state === 'idle' ? 'more' : list.state;
  const nextHref = list.next ? feedHref(path, { ...search, cursor: list.next }) : undefined;
  const firstHref = search.cursor ? feedHref(path, { ...search, cursor: undefined }) : undefined;
  return (
    <div className="feed-posts" ref={box}>
      {data.signIn ? (
        <EmptyState
          title={t('feeds', 'moderating.signIn.title')}
          action={<Link href={`/auth/sign-in?redirect=${encodeURIComponent(path)}`}>{t('feeds', 'moderating.signIn.link')}</Link>}
        >
          {t('feeds', 'moderating.signIn.body')}
        </EmptyState>
      ) : reading ? (
        <div className="pb-rows" aria-busy="true">
          <FeedSkeleton density={prefs.density} label={t('shell', 'loading.posts')} />
        </div>
      ) : rows.length === 0 ? (
        empty
      ) : (
        <>
          {auto && <FeedSkip label={t('feeds', 'skip')} onSkip={skip} />}
          <ul className="feed-list pb-rows" aria-label={t('feeds', 'list.label')}>
            {rows.map((row) => (
              <li key={row.post.id} data-post={row.post.id}>
                <FeedRow
                  row={row}
                  density={prefs.density}
                  signedIn={data.signedIn}
                  actions={rowActions}
                  hydrated={hydrated}
                  voteFailed={voteFailed}
                  voted={acknowledgeVote}
                />
              </li>
            ))}
          </ul>
          {more && (auto || state === 'end') && (
            <FeedEnd
              state={state}
              density={prefs.density}
              labels={{ failed: t('feeds', 'more.failed'), retry: t('feeds', 'more.retry'), end: t('feeds', 'end') }}
              onRetry={retry}
              sentinelRef={sentinel}
              endRef={end}
              fallback={nextHref && <Link href={nextHref}>{t('feeds', 'next')}</Link>}
            />
          )}
        </>
      )}

      {!data.signIn && !reading && (
        <Pager
          aria-label={t('feeds', 'pages.label')}
          first={firstHref ? { href: firstHref, label: t('feeds', 'first') } : undefined}
          next={nextHref && !auto ? { href: nextHref, label: t('feeds', 'next') } : undefined}
        />
      )}
      {more && (
        <Text role="status" className="pb-sr">
          {list.said}
        </Text>
      )}
    </div>
  );
}

/**
 * One row: the post, its vote (a refusal or a failed request says so, then throws, which puts the
 * arrows and the score back) and, with `actions`, Share and the menu with Copy link, whose result a
 * polite status beside them says for a few seconds.
 */
function FeedRow({
  row: { post, thumbnailSrc, now },
  density,
  signedIn,
  actions,
  hydrated,
  voteFailed,
  voted,
}: {
  row: Row;
  density: Density;
  signedIn: boolean;
  actions: boolean;
  hydrated: boolean;
  voteFailed: () => void;
  voted: typeof acknowledgeVote;
}) {
  const { t, locale } = useTranslate();
  const postLabels = { ...usePostCardLabels(), voteOn: (title: string) => t('posts', 'vote.on', { title }) };
  const [status, say] = useStatus();
  const save = useRowSave(post, say);
  const link = () => new URL(postPath(post.id), window.location.origin).href;
  const copy = async () => say(t('feeds', (await copyLink(link())) ? 'row.copied' : 'row.copyFailed'));
  const share = async () => {
    const result = await shareLink(post.title, link());
    if (result === 'copied') say(t('feeds', 'row.copied'));
    else if (result === 'failed') say(t('feeds', 'row.copyFailed'));
  };
  return (
    <PostRow
      post={post}
      density={density}
      hrefs={{ post: postPath(post.id), community: communityPath(post.community), author: userPath(post.author) }}
      labels={postLabels}
      locale={locale}
      onVote={async (value) => {
        try {
          const result = await castVoteFn({ data: { target: { kind: 'post', id: post.id }, value } });
          if (!result.ok) throw new Error(result.reason);
          voted(post.id, result.value, result.tally);
        } catch (error) {
          voteFailed();
          throw error;
        }
      }}
      voteDisabled={!signedIn || post.deleted}
      now={new Date(now)}
      thumbnailSrc={thumbnailSrc}
      onShare={actions ? () => void share() : undefined}
      actions={
        actions && (
          <FeedRowActions
            labels={{ more: t('feeds', 'row.more', { title: post.title }), list: t('feeds', 'row.list'), copy: t('feeds', 'row.copy') }}
            publishedAt={post.publishedAt}
            locale={locale}
            onCopy={() => void copy()}
            status={status}
            disabled={!hydrated}
            save={signedIn && !post.deleted ? save : undefined}
          />
        )
      }
    />
  );
}

/** A short status: what `say` was given, for five seconds. */
function useStatus(): [string, (message: string) => void] {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const say = useCallback((message: string) => {
    clearTimeout(timer.current);
    setStatus(message);
    timer.current = setTimeout(() => setStatus(''), 5000);
  }, []);
  return [status, say];
}

async function copyLink(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * The system's share sheet where there is one (it confirms itself; a cancel is no error), else the
 * link is copied. A share that fails otherwise falls back to the copy as well.
 */
async function shareLink(title: string, url: string): Promise<'shared' | 'cancelled' | 'copied' | 'failed'> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, url });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyLink(url)) ? 'copied' : 'failed';
}

/**
 * Says that a vote was not saved, in a Mux toast (the root's ToastProvider; announced, since a
 * toast is an alert). A burst of failures (several queued votes, or votes on several posts with an
 * expired session) gives one toast: no other is added while it shows.
 */
function useVoteFailedToast() {
  const toast = useToast();
  const { t } = useTranslate();
  const showing = useRef(false);
  return () => {
    if (showing.current) return;
    showing.current = true;
    toast.add(t('feeds', 'vote.failed.body'), {
      title: t('feeds', 'vote.failed.title'),
      variant: 'danger',
      onDismiss: () => {
        showing.current = false;
      },
    });
  };
}

/**
 * The feed's rail: what the feed holds, in words that are true of this server, and from the sidebar's
 * own data how many communities the viewer follows or moderates, with the way to the directory.
 */
function FeedRail({ feed }: { feed: FeedName }) {
  const { t, locale } = useTranslate();
  const { shell, session } = root.useLoaderData();
  const site = shell.siteName;
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  const text = {
    subscribed: t('feeds', 'rail.subscribed'),
    local: t('feeds', 'rail.local', { site }),
    all: t('feeds', 'rail.all', { site }),
    popular: t('feeds', 'rail.popular'),
    moderating: t('feeds', 'rail.moderating'),
  }[feed];
  const facts =
    session && feed === 'subscribed'
      ? [{ key: 'following', label: t('feeds', 'rail.following'), value: count(shell.local.length + shell.remote.length) }]
      : session && feed === 'moderating'
        ? [{ key: 'moderating', label: t('feeds', 'rail.moderatingCount'), value: count(shell.moderating) }]
        : [];
  return (
    <Rail label={t('feeds', 'rail.label')}>
      <RailPanel title={t('shell', feedTitleKeys[feed])}>
        <Text as="p" size="sm" className="feed-rail__text">
          {text}
        </Text>
        {facts.length > 0 && <FactList items={facts} size="xs" />}
        <Link href={directoryPaths.browse}>{t('feeds', 'rail.browse')}</Link>
      </RailPanel>
    </Rail>
  );
}

/** Nothing to show: an empty home feed says how to fill it, the others say that it is quiet. */
function Empty({ feed }: { feed: FeedName }) {
  const { t } = useTranslate();
  if (feed === 'subscribed')
    return (
      <EmptyState
        title={t('feeds', 'empty.subscribed.title')}
        action={
          <>
            <Link href={directoryPaths.browse}>{t('feeds', 'empty.browse')}</Link>
            <Link href={feedPaths.all}>{t('feeds', 'empty.all')}</Link>
          </>
        }
      >
        {t('feeds', 'empty.subscribed.body')}
      </EmptyState>
    );
  return (
    <EmptyState title={t('feeds', 'empty.title')}>{t('feeds', feed === 'moderating' ? 'moderating.empty.body' : 'empty.body')}</EmptyState>
  );
}
