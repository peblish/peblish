import type { FeedName, Period, Sort } from '@peblish/core/feeds/input';
import type { ReactNode } from 'react';
import { periods, sorts } from '@peblish/core/feeds/input';
import { Group } from '@peblish/ui/components/group';
import { Link } from '@peblish/ui/components/link';
import { PostCard } from '@peblish/ui/components/post-card';
import { Text } from '@peblish/ui/components/text';
import { DensityControl } from '@peblish/ui/density/density-control';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { useDensityLabels, usePostCardLabels } from '../../../shell/labels.ts';
import { communityPath, directoryPaths, feedPaths, postPath, userPath } from '../../../shell/paths.ts';
import { usePrefs } from '../../../shell/prefs.tsx';
import { castVoteFn } from '../../post/-vote.ts';
import type { FeedData } from './load.ts';
import { feedHref, resolveFeedSearch, type FeedSearch } from './search.ts';

// A feed: the feed's name, the sort as Mux UI links (so the toolbar works before the page
// hydrates and without JavaScript), the always-visible density switch (a Mux ToggleButtonGroup),
// the posts, and a link to the next page. FeedToolbar and FeedCards are the same parts without
// the heading, for other pages that list posts (a community page, a profile).

const feedTitleKeys = {
  subscribed: 'feed.subscribed',
  local: 'feed.local',
  all: 'feed.all',
  popular: 'feed.popular',
  moderating: 'feed.moderating',
} as const;

/** One sort or period: a Mux Link, marked `aria-current="page"` when it is the one shown. */
function Choice({ href, current, children }: { href: string; current: boolean; children: string }) {
  return (
    <Link href={href} current={current}>
      {children}
    </Link>
  );
}

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
      <Group className="feed-seg" aria-label={t('feeds', 'sort.group')}>
        {sorts.map((value: Sort) => (
          <Choice key={value} href={feedHref(path, { ...search, sort: value, cursor: undefined })} current={sort === value}>
            {t('feeds', `sort.${value}`)}
          </Choice>
        ))}
      </Group>
      {sort === 'top' && (
        <Group className="feed-seg" aria-label={t('feeds', 'period.group')}>
          {periods.map((value) => (
            <Choice key={value} href={feedHref(path, { sort, period: value })} current={search.period === value}>
              {periodOf(value)}
            </Choice>
          ))}
        </Group>
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
  const postLabels = usePostCardLabels();
  return (
    <>
      {data.signIn ? (
        <section className="feed-empty">
          <Text as="h2" variant="title" size="sm">
            {t('feeds', 'moderating.signIn.title')}
          </Text>
          <Text as="p">{t('feeds', 'moderating.signIn.body')}</Text>
          <Text as="p">
            <Link href={`/auth/sign-in?redirect=${encodeURIComponent(path)}`}>{t('feeds', 'moderating.signIn.link')}</Link>
          </Text>
        </section>
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
                // A refusal throws, which puts the arrows and the score back.
                onVote={async (value) => {
                  const result = await castVoteFn({ data: { target: { kind: 'post', id: post.id }, value } });
                  if (!result.ok) throw new Error(result.reason);
                }}
                voteDisabled={!data.signedIn || post.deleted}
                now={new Date(data.now)}
                thumbnailSrc={thumbnailSrc}
              />
            </li>
          ))}
        </ul>
      )}

      {(data.next || search.cursor) && !data.signIn && (
        <nav className="feed-pages" aria-label={t('feeds', 'pages.label')}>
          {search.cursor && <Link href={feedHref(path, { ...search, cursor: undefined })}>{t('feeds', 'first')}</Link>}
          {data.next && (
            <Link href={feedHref(path, { ...search, cursor: data.next })} rel="next">
              {t('feeds', 'next')}
            </Link>
          )}
        </nav>
      )}
    </>
  );
}

/** Nothing to show: an empty home feed says how to fill it, the others say that it is quiet. */
function Empty({ feed }: { feed: FeedName }) {
  const { t } = useTranslate();
  if (feed === 'subscribed')
    return (
      <section className="feed-empty">
        <Text as="h2" variant="title" size="sm">
          {t('feeds', 'empty.subscribed.title')}
        </Text>
        <Text as="p">{t('feeds', 'empty.subscribed.body')}</Text>
        <Text as="p">
          <Link href={directoryPaths.browse}>{t('feeds', 'empty.browse')}</Link> ·{' '}
          <Link href={feedPaths.all}>{t('feeds', 'empty.all')}</Link>
        </Text>
      </section>
    );
  return (
    <section className="feed-empty">
      <Text as="h2" variant="title" size="sm">
        {t('feeds', 'empty.title')}
      </Text>
      <Text as="p">{t('feeds', feed === 'moderating' ? 'moderating.empty.body' : 'empty.body')}</Text>
    </section>
  );
}
