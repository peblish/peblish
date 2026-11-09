import type { FeedName, Period, Sort } from '@peblish/core/feeds/input';
import { periods, sorts } from '@peblish/core/feeds/input';
import { PostCard } from '@peblish/ui/components/post-card';
import { DensityControl } from '@peblish/ui/density/density-control';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { useDensityLabels, usePostCardLabels } from '../../../shell/labels.ts';
import { communityPath, directoryPaths, feedPaths, postPath, userPath } from '../../../shell/paths.ts';
import { usePrefs } from '../../../shell/prefs.tsx';
import { castVoteFn } from '../../post/-vote.ts';
import type { FeedData } from './load.ts';
import { feedHref, resolveFeedSearch, type FeedSearch } from './search.ts';

// A feed after feed-segmented.html: the feed's name, the sort as links (so the toolbar works
// before the page hydrates and without JavaScript), the always-visible density switch, the posts
// as cards, and a link to the next page. No Mux collection component sits on the toolbar or
// the rows (first-tap condition).

const feedTitleKeys = {
  subscribed: 'feed.subscribed',
  local: 'feed.local',
  all: 'feed.all',
  popular: 'feed.popular',
  moderating: 'feed.moderating',
} as const;

function Choice({ href, current, children }: { href: string; current: boolean; children: string }) {
  return (
    <a href={href} aria-current={current ? 'true' : undefined}>
      {children}
    </a>
  );
}

export function FeedPage({ path, data, search: address }: { path: string; data: FeedData; search: FeedSearch }) {
  const search = resolveFeedSearch(address);
  const { t, locale } = useTranslate();
  const { prefs, setPrefs } = usePrefs();
  const postLabels = usePostCardLabels();
  const densityLabels = useDensityLabels();
  useRouteHydrated();
  const { feed } = data;
  const sort = search.sort;
  const periodOf = (period: Period) => t('feeds', `period.${period}`);

  return (
    <main className="pb-page feed" data-feed={feed}>
      <div className="feed-toolbar">
        <h1>{t('shell', feedTitleKeys[feed])}</h1>
        <div className="feed-seg" role="group" aria-label={t('feeds', 'sort.group')}>
          {sorts.map((value: Sort) => (
            <Choice key={value} href={feedHref(path, { ...search, sort: value, cursor: undefined })} current={sort === value}>
              {t('feeds', `sort.${value}`)}
            </Choice>
          ))}
        </div>
        {sort === 'top' && (
          <div className="feed-seg" role="group" aria-label={t('feeds', 'period.group')}>
            {periods.map((value) => (
              <Choice key={value} href={feedHref(path, { sort, period: value })} current={search.period === value}>
                {periodOf(value)}
              </Choice>
            ))}
          </div>
        )}
        <span className="feed-space" />
        <DensityControl value={prefs.density} onChange={(density) => setPrefs({ density })} labels={densityLabels} />
      </div>

      {data.signIn ? (
        <section className="feed-empty">
          <h2>{t('feeds', 'moderating.signIn.title')}</h2>
          <p>{t('feeds', 'moderating.signIn.body')}</p>
          <p>
            <a href={`/auth/sign-in?redirect=${encodeURIComponent(path)}`}>{t('feeds', 'moderating.signIn.link')}</a>
          </p>
        </section>
      ) : data.items.length === 0 ? (
        <Empty feed={feed} />
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
          {search.cursor && <a href={feedHref(path, { ...search, cursor: undefined })}>{t('feeds', 'first')}</a>}
          {data.next && (
            <a href={feedHref(path, { ...search, cursor: data.next })} rel="next">
              {t('feeds', 'next')}
            </a>
          )}
        </nav>
      )}
    </main>
  );
}

/** Nothing to show: an empty home feed says how to fill it, the others say that it is quiet. */
function Empty({ feed }: { feed: FeedName }) {
  const { t } = useTranslate();
  if (feed === 'subscribed')
    return (
      <section className="feed-empty">
        <h2>{t('feeds', 'empty.subscribed.title')}</h2>
        <p>{t('feeds', 'empty.subscribed.body')}</p>
        <p>
          <a href={directoryPaths.browse}>{t('feeds', 'empty.browse')}</a> · <a href={feedPaths.all}>{t('feeds', 'empty.all')}</a>
        </p>
      </section>
    );
  return (
    <section className="feed-empty">
      <h2>{t('feeds', 'empty.title')}</h2>
      <p>{t('feeds', feed === 'moderating' ? 'moderating.empty.body' : 'empty.body')}</p>
    </section>
  );
}
