import { EmptyState } from '@peblish/ui/components/empty-state';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Pager } from '@peblish/ui/components/pager';
import { PostRow } from '@peblish/ui/components/post-row';
import { RailPanel } from '@peblish/ui/components/rail-panel';
import { Text } from '@peblish/ui/components/text';
import { useToast } from '@peblish/ui/components/toast';
import { useEffect, useRef, useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { usePostCardLabels } from '../../../shell/labels.ts';
import { communityPath, feedPaths, postPath, savedPath, userPath } from '../../../shell/paths.ts';
import { usePrefs } from '../../../shell/prefs.tsx';
import { Rail } from '../../../shell/rail.tsx';
import { ViewHeader } from '../../../shell/view-header.tsx';
import { castVoteFn } from '../../post/-vote.ts';
import type { SavedData, SavedItem } from '../-load.ts';
import { failureKey } from './save-request.ts';
import { SaveForm } from './save-form.tsx';

// /saved (Commons has no Saved view; built from the feed's parts): the viewer's saved posts, newest save
// first, as the feed's rows in the viewer's density, each with its vote and an Unsave, then the links to
// the first and the next page, and a rail that says who can see the list. Unsave removes the row in
// place and a polite status says it was removed; when focus left with the row it moves to the next
// remaining row's title, else the previous one's, else what follows the list (on a later page that is
// Newest saves: the empty state with Browse All is for an account with no saves). Unsaves that overlap
// each remove their own row. A failed Unsave leaves the row and its focus and says so there.
// With scripts off every Unsave is a plain form (303 back to this page) and paging is links.

const noneGone: ReadonlySet<string> = new Set();

export const savedHref = (cursor?: string) => (cursor ? `${savedPath}?cursor=${encodeURIComponent(cursor)}` : savedPath);

export function SavedPage({ data, cursor, error }: { data: SavedData; cursor?: string | undefined; error?: string | undefined }) {
  useRouteHydrated();
  const { t } = useTranslate();
  // The rows removed from this page's data; a new page of data starts with every one of its rows.
  const [removedFrom, setRemovedFrom] = useState<{ data: SavedData; ids: ReadonlySet<string> }>({ data, ids: new Set() });
  const gone = removedFrom.data === data ? removedFrom.ids : noneGone;
  const [said, setSaid] = useState('');
  const list = useRef<HTMLDivElement>(null);
  // The row last removed, whose remaining neighbour takes focus once it has left the list.
  const lastRemoved = useRef<string | null>(null);

  const rows = data.items.filter((item) => !gone.has(item.post.id));
  const here = savedHref(cursor);

  // Merged into the latest set: an Unsave that answers after another one keeps the other's removal.
  const removed = (id: string) => {
    lastRemoved.current = id;
    setRemovedFrom((latest) => ({ data, ids: new Set(latest.data === data ? latest.ids : noneGone).add(id) }));
    setSaid(t('saves', 'status.unsaved'));
  };

  useEffect(() => {
    const id = lastRemoved.current;
    if (id === null) return;
    lastRemoved.current = null;
    // Focus that is elsewhere (another row's Unsave still on its way) stays there.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const at = data.items.findIndex((item) => item.post.id === id);
    const stays = (item: SavedItem) => !gone.has(item.post.id);
    const target = data.items.slice(at + 1).find(stays) ?? data.items.slice(0, Math.max(at, 0)).findLast(stays);
    const box = list.current;
    const title = target && box?.querySelector<HTMLElement>(`[data-saved-post="${CSS.escape(target.post.id)}"] .pb-post__title a[href]`);
    (title ?? box?.querySelector<HTMLElement>('.saved-after a[href]'))?.focus();
  }, [gone, data]);

  const nextHref = data.next ? savedHref(data.next) : undefined;
  return (
    <>
      <main className="pb-page saved">
        <ViewHeader
          root
          title={
            <Text as="h1" variant="label" className="pb-frame-vh__title">
              {t('saves', 'title')}
            </Text>
          }
        />
        <div className="saved-posts" ref={list}>
          {error && (
            <Notice tone="danger" role="alert">
              {t('saves', failureKey('unsave', error))}
            </Notice>
          )}
          {rows.length === 0 && !nextHref && cursor ? (
            <EmptyState title={t('saves', 'empty.later')} />
          ) : rows.length === 0 && !nextHref ? (
            <EmptyState
              title={t('saves', 'empty.title')}
              className="saved-after"
              action={<Link href={feedPaths.all}>{t('saves', 'empty.all')}</Link>}
            >
              {t('saves', 'empty.body')}
            </EmptyState>
          ) : (
            <ul className="saved-list feed-list pb-rows" aria-label={t('saves', 'list.label')}>
              {rows.map((item) => (
                <li key={item.post.id} data-saved-post={item.post.id}>
                  <SavedRow item={item} now={data.now} back={here} onRemoved={removed} />
                </li>
              ))}
            </ul>
          )}
          <Pager
            aria-label={t('saves', 'pages.label')}
            className="saved-after"
            first={cursor ? { href: savedPath, label: t('saves', 'first') } : undefined}
            next={nextHref ? { href: nextHref, label: t('saves', 'next') } : undefined}
          />
          <Text role="status" className="pb-sr">
            {said}
          </Text>
        </div>
      </main>
      <Rail label={t('saves', 'rail.label')}>
        <RailPanel title={t('saves', 'title')}>
          <Text as="p" size="sm">
            {t('saves', 'rail.body')}
          </Text>
        </RailPanel>
      </Rail>
    </>
  );
}

/** One saved post: the feed's row, its vote (a failure says so and puts the vote back) and Unsave. */
function SavedRow({ item, now, back, onRemoved }: { item: SavedItem; now: string; back: string; onRemoved: (id: string) => void }) {
  const { t, locale } = useTranslate();
  const { prefs } = usePrefs();
  const toast = useToast();
  const { post, thumbnailSrc } = item;
  return (
    <PostRow
      post={post}
      density={prefs.density}
      hrefs={{ post: postPath(post.id), community: communityPath(post.community), author: userPath(post.author) }}
      labels={usePostCardLabels()}
      locale={locale}
      thumbnailSrc={thumbnailSrc}
      now={new Date(now)}
      onVote={async (value) => {
        try {
          const result = await castVoteFn({ data: { target: { kind: 'post', id: post.id }, value } });
          if (!result.ok) throw new Error(result.reason);
        } catch (error) {
          toast.add(t('feeds', 'vote.failed.body'), { title: t('feeds', 'vote.failed.title'), variant: 'danger' });
          throw error;
        }
      }}
      actions={<SaveForm postId={post.id} title={post.title} saved back={back} inList onDone={() => onRemoved(post.id)} />}
    />
  );
}
