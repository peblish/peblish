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
import { periods, sorts } from '@peblish/core/feeds/input';
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
import { DensityControl, densities } from '@peblish/ui/density/density-control';
import { getRouteApi, useLocation, useRouter } from '@tanstack/react-router';
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
import { loadFeed, type FeedData } from './load.ts';
import { firstPlace, loadNext, readPlace, subscribePlaces, updateRows, type Batch, type Place, type PlaceRow } from './places.ts';
import type { FeedRoute } from './route.ts';
import { feedHref, resolveFeedSearch, type FeedSearch } from './search.ts';

// A feed (Commons): its own view header with the feed's name and the Sort and View menus (with scripts
// off, the sort and Top period as LinkTabs instead), the posts, which load their next batch by
// themselves as the reader nears the end, and the rail. FeedToolbar and FeedCards are the parts for
// other pages that list posts (a community page, a profile); FeedCards takes the auto-load (`more`)
// and the rows' Share and Copy link (`rowActions`) only when asked, and is otherwise as it was.

const root = getRouteApi('__root__');

const feedTitleKeys = {
  subscribed: 'feed.subscribed',
  local: 'feed.local',
  all: 'feed.all',
  popular: 'feed.popular',
  moderating: 'feed.moderating',
} as const;

const feedIcons: Record<FeedName, ComponentType<IconProps>> = {
  subscribed: HouseIcon,
  local: MapPinIcon,
  all: GlobeIcon,
  popular: FlameIcon,
  moderating: ShieldIcon,
};

const sortIcons: Record<Sort, ComponentType<IconProps>> = { hot: FlameIcon, new: SortNewIcon, old: SortOldIcon, top: SortTopIcon };
const viewIcons: Record<Density, ComponentType<IconProps>> = { card: ViewCardIcon, classic: ViewClassicIcon, compact: ViewCompactIcon };

export function FeedPage({ path, data, search }: { path: string; data: FeedData; search: FeedSearch }) {
  useRouteHydrated();
  const feed = feedOf(path);
  const { sort, period, cursor: start } = resolveFeedSearch(search);
  const more = useMemo<FeedMore>(
    () => ({
      key: feedHref(path, { sort, period, cursor: start }),
      load: (cursor) => loadFeed({ data: { feed, sort, period, cursor } }).then(({ items, next, now }) => ({ items, next, now })),
    }),
    [path, feed, sort, period, start],
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
    onChange: (sort: Sort, period?: Period) => openInRouter(router, feedHref(path, { sort, period: period ?? search.period })),
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
        <SortLinks path={path} search={search} />
      </div>
    </>
  );
}

/** The sort and, for Top, its period as LinkTabs: real links, which work before hydration and without scripts. */
function SortLinks({ path, search }: { path: string; search: ReturnType<typeof resolveFeedSearch> }) {
  const { t } = useTranslate();
  return (
    <>
      <LinkTabs
        aria-label={t('feeds', 'sort.group')}
        className="feed-tabs"
        variant="segment"
        size="sm"
        items={sorts.map((value: Sort) => ({
          to: feedHref(path, { ...search, sort: value, cursor: undefined }),
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
            to: feedHref(path, { sort: 'top', period: value }),
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

/** What the cards need of a page's data: the posts, the clock their ages print against, the next cursor. */
export type FeedCardsData = Pick<FeedData, 'items' | 'next' | 'now' | 'signedIn'> & { signIn?: boolean };

/**
 * Auto-load for FeedCards: `key` names the list (its address: path, sort, period, first cursor), and
 * `load` reads the batch after a cursor. FeedCards keys the place by viewer and history entry as well.
 */
export interface FeedMore {
  key: string;
  load: (cursor: string) => Promise<Batch>;
}

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
 * IntersectionObserver the next page stays a plain link. The loaded rows are kept for the visit
 * (places.ts) under the history entry, so Back finds them and the router puts the scroll position back.
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
  const voteFailed = useVoteFailedToast();
  const viewer = root.useLoaderData({ select: ({ session }) => session?.actorId ?? '' });
  const entry = useLocation({ select: (location) => location.state.__TSR_key ?? '' });
  const key = `${viewer}\n${entry}\n${more?.key ?? ''}`;
  const first = useMemo(() => firstPlace(data), [data]);
  const place: Place = useSyncExternalStore(
    subscribePlaces,
    () => (more ? (readPlace(key) ?? first) : first),
    () => first,
  );
  const auto = more !== undefined && hydrated && typeof IntersectionObserver !== 'undefined';

  // A kept place shows its own rows, not the page's data. When the page's data comes again (Back reloads
  // the first page in the background), the posts it holds are taken from it: a vote cast on the post's
  // own page, a new comment count.
  useEffect(() => {
    if (!more || !readPlace(key)) return;
    for (const item of data.items) updateRows(key, item.post.id, (row) => ({ ...row, post: item.post }));
  }, [data, key, more]);
  // A saved vote is written into the kept place too, so Back shows it.
  const voted = (postId: string, myVote: -1 | 0 | 1, tally: { upvotes: number; downvotes: number }) => {
    if (more) updateRows(key, postId, (row) => ({ ...row, post: { ...row.post, myVote, counts: { ...row.post.counts, ...tally } } }));
  };

  const box = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const messages = {
    loaded: (count: number, last: boolean) =>
      `${translatePlural(locale, 'feeds', 'more.loaded', count)}${last ? ` ${t('feeds', 'end')}` : ''}`,
    failed: t('feeds', 'more.failed'),
  };
  // What the observer and Retry read when they fire: this render's list, not the one they were made in.
  const latest = useRef({ key, place, more, messages });
  useLayoutEffect(() => {
    latest.current = { key, place, more, messages };
  });
  const next = useCallback(() => {
    const { key, place, more, messages } = latest.current;
    if (more) loadNext(key, place, more.load, messages);
  }, []);

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
    retried.current = place.rows.length;
    end.current?.focus({ preventScroll: true });
    next();
  };
  useEffect(() => {
    const from = retried.current;
    if (from === null || place.state === 'pending') return;
    retried.current = null;
    if (document.activeElement !== end.current) return;
    const target =
      place.state === 'failed'
        ? end.current?.querySelector<HTMLElement>('button')
        : box.current?.querySelectorAll('.feed-list > li')[from]?.querySelector<HTMLElement>('.pb-post__title a[href]');
    target?.focus();
  }, [place.state, place.rows.length]);

  const skip = () => {
    const list = box.current;
    if (!list) return;
    const after = [...document.querySelectorAll<HTMLElement>(focusable)].find(
      (element) =>
        !list.contains(element) && list.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING && element.checkVisibility(),
    );
    (after ?? end.current)?.focus();
  };

  const state: FeedEndState = place.next === null ? 'end' : place.state === 'idle' ? 'more' : place.state;
  const nextHref = place.next ? feedHref(path, { ...search, cursor: place.next }) : undefined;
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
      ) : place.rows.length === 0 ? (
        empty
      ) : (
        <>
          {auto && <FeedSkip label={t('feeds', 'skip')} onSkip={skip} />}
          <ul className="feed-list pb-rows" aria-label={t('feeds', 'list.label')}>
            {place.rows.map((row) => (
              <li key={row.post.id}>
                <FeedRow
                  row={row}
                  density={prefs.density}
                  signedIn={data.signedIn}
                  actions={rowActions}
                  hydrated={hydrated}
                  voteFailed={voteFailed}
                  voted={voted}
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

      {!data.signIn && (
        <Pager
          aria-label={t('feeds', 'pages.label')}
          first={firstHref ? { href: firstHref, label: t('feeds', 'first') } : undefined}
          next={nextHref && !auto ? { href: nextHref, label: t('feeds', 'next') } : undefined}
        />
      )}
      {more && (
        <Text role="status" className="pb-sr">
          {place.said}
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
  row: PlaceRow;
  density: Density;
  signedIn: boolean;
  actions: boolean;
  hydrated: boolean;
  voteFailed: () => void;
  voted: (postId: string, myVote: -1 | 0 | 1, tally: { upvotes: number; downvotes: number }) => void;
}) {
  const { t, locale } = useTranslate();
  const postLabels = { ...usePostCardLabels(), voteOn: (title: string) => t('posts', 'vote.on', { title }) };
  const [status, say] = useStatus();
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
            onCopy={() => void copy()}
            status={status}
            disabled={!hydrated}
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
