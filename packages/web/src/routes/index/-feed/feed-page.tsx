import type { FeedName, Period, Sort } from '@peblish/core/feeds/input';
import { useRef, type ReactNode } from 'react';
import { periods, sorts } from '@peblish/core/feeds/input';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { Link } from '@peblish/ui/components/link';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Pager } from '@peblish/ui/components/pager';
import { PostCard } from '@peblish/ui/components/post-card';
import { Text } from '@peblish/ui/components/text';
import { useToast } from '@peblish/ui/components/toast';
import { DensityControl } from '@peblish/ui/density/density-control';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { useDensityLabels, usePostCardLabels } from '../../../shell/labels.ts';
import { communityPath, directoryPaths, feedPaths, postPath, userPath } from '../../../shell/paths.ts';
import { usePrefs } from '../../../shell/prefs.tsx';
import { castVoteFn } from '../../post/-vote.ts';
import type { FeedData } from './load.ts';
import { feedHref, resolveFeedSearch, type FeedSearch } from './search.ts';

// A feed: the feed's name, the sort and Top period as LinkTabs (real links, so the toolbar works
// before the page hydrates and without JavaScript), the always-visible density switch (a Mux ToggleButtonGroup),
// the posts, and a link to the next page. FeedToolbar and FeedCards are the same parts without
// the heading, for other pages that list posts (a community page, a profile).

const feedTitleKeys = {
  subscribed: 'feed.subscribed',
  local: 'feed.local',
  all: 'feed.all',
  popular: 'feed.popular',
  moderating: 'feed.moderating',
} as const;

export function FeedPage({ path, data, search }: { path: string; data: FeedData; search: FeedSearch }) {
  const { t } = useTranslate();
  useRouteHydrated();
  return (
    <main className="pb-page feed" data-feed={data.feed}>
      <FeedToolbar path={path} search={search}>
        <Text as="h1" variant="heading" size="sm">
          {t('shell', feedTitleKeys[data.feed])}
        </Text>
      </FeedToolbar>
      <FeedCards path={path} data={data} search={search} empty={<Empty feed={data.feed} />} />
    </main>
  );
}

/**
 * The sort and Top period as links to `path`, and the density switch. `children` come first in
 * the bar (a feed's heading). For any page that lists posts the feed way (a community, a profile).
 */
export function FeedToolbar({ path, search: address, children }: { path: string; search: FeedSearch; children?: ReactNode }) {
  const search = resolveFeedSearch(address);
  const { t } = useTranslate();
  const { prefs, setPrefs } = usePrefs();
  const densityLabels = useDensityLabels();
  const sort = search.sort;
  const periodOf = (period: Period) => t('feeds', `period.${period}`);
  return (
    <div className="feed-toolbar">
      {children}
      <LinkTabs
        aria-label={t('feeds', 'sort.group')}
        variant="segment"
        size="sm"
        items={sorts.map((value: Sort) => ({
          to: feedHref(path, { ...search, sort: value, cursor: undefined }),
          label: t('feeds', `sort.${value}`),
          active: sort === value,
        }))}
      />
      {sort === 'top' && (
        <LinkTabs
          aria-label={t('feeds', 'period.group')}
          variant="segment"
          size="sm"
          items={periods.map((value: Period) => ({
            to: feedHref(path, { sort, period: value }),
            label: periodOf(value),
            active: search.period === value,
          }))}
        />
      )}
      <span className="feed-space" />
      <DensityControl value={prefs.density} onChange={(density) => setPrefs({ density })} labels={densityLabels} />
    </div>
  );
}

/** What the cards need of a page's data: the posts, the clock their ages print against, the next cursor. */
export type FeedCardsData = Pick<FeedData, 'items' | 'next' | 'now' | 'signedIn'> & { signIn?: boolean };

/**
 * The posts as cards and the links to the first and next page, under `path`. `empty` shows when
 * there are no posts; a Moderating feed without a viewer (`signIn`) asks to sign in instead.
 */
export function FeedCards({
  path,
  data,
  search: address,
  empty,
}: {
  path: string;
  data: FeedCardsData;
  search: FeedSearch;
  empty: ReactNode;
}) {
  const search = resolveFeedSearch(address);
  const { t, locale } = useTranslate();
  const { prefs } = usePrefs();
  const postLabels = { ...usePostCardLabels(), voteOn: (title: string) => t('posts', 'vote.on', { title }) };
  const voteFailed = useVoteFailedToast();
  return (
    <>
      {data.signIn ? (
        <EmptyState
          title={t('feeds', 'moderating.signIn.title')}
          action={<Link href={`/auth/sign-in?redirect=${encodeURIComponent(path)}`}>{t('feeds', 'moderating.signIn.link')}</Link>}
        >
          {t('feeds', 'moderating.signIn.body')}
        </EmptyState>
      ) : data.items.length === 0 ? (
        empty
      ) : (
        <ul className="feed-list" aria-label={t('feeds', 'list.label')}>
          {data.items.map(({ post, thumbnailSrc }) => (
            <li key={post.id}>
              <PostCard
                post={post}
                density={prefs.density}
                hrefs={{ post: postPath(post.id), community: communityPath(post.community), author: userPath(post.author) }}
                labels={postLabels}
                locale={locale}
                // A refusal (or a failed request) says so, then throws, which puts the arrows and the score back.
                onVote={async (value) => {
                  try {
                    const result = await castVoteFn({ data: { target: { kind: 'post', id: post.id }, value } });
                    if (!result.ok) throw new Error(result.reason);
                  } catch (error) {
                    voteFailed();
                    throw error;
                  }
                }}
                voteDisabled={!data.signedIn || post.deleted}
                now={new Date(data.now)}
                thumbnailSrc={thumbnailSrc}
              />
            </li>
          ))}
        </ul>
      )}

      {!data.signIn && (
        <Pager
          aria-label={t('feeds', 'pages.label')}
          first={search.cursor ? { href: feedHref(path, { ...search, cursor: undefined }), label: t('feeds', 'first') } : undefined}
          next={data.next ? { href: feedHref(path, { ...search, cursor: data.next }), label: t('feeds', 'next') } : undefined}
        />
      )}
    </>
  );
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
