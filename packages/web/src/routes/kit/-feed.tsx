import { FeedEnd, FeedSkip, type FeedEndState } from '@peblish/ui/components/feed-end';
import { SortMenu, ViewMenu, type MenuChoice } from '@peblish/ui/components/feed-menus';
import { FeedRowActions } from '@peblish/ui/components/feed-row-actions';
import {
  FlameIcon,
  SortNewIcon,
  SortOldIcon,
  SortTopIcon,
  ViewCardIcon,
  ViewClassicIcon,
  ViewCompactIcon,
} from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { Pager } from '@peblish/ui/components/pager';
import { useTranslate } from '../../i18n/use-translate.ts';
import { useDensityLabels } from '../../shell/labels.ts';
import type { Composition } from './-states.tsx';

// The feed lane's state pages (/kit/<key>), registered in -states.tsx: the header's Sort and View menus, a
// row's Share and Copy link confirmation with its menu, and the ends of a list that loads by itself (Retry,
// pending, the end line) with Skip past the posts. The words come from the feeds catalogue.

function Sort({ top = false, disabled }: { top?: boolean; disabled?: boolean }) {
  const { t } = useTranslate();
  const icons = { hot: FlameIcon, new: SortNewIcon, old: SortOldIcon, top: SortTopIcon };
  const sorts: MenuChoice<'hot' | 'new' | 'old' | 'top'>[] = (['hot', 'new', 'old', 'top'] as const).map((id) => ({
    id,
    label: t('feeds', `sort.${id}`),
    icon: icons[id],
  }));
  const periods: MenuChoice<'day' | 'week'>[] = (['day', 'week'] as const).map((id) => ({ id, label: t('feeds', `period.${id}`) }));
  return (
    <SortMenu
      sorts={sorts}
      sort={top ? 'top' : 'hot'}
      periodSort="top"
      periods={periods}
      period="week"
      labels={{
        group: t('feeds', 'sort.group'),
        periodGroup: t('feeds', 'period.group'),
        current: t('feeds', 'menu.current'),
        trigger: top
          ? t('feeds', 'header.sortTop', { period: t('feeds', 'period.week') })
          : t('feeds', 'header.sort', { sort: t('feeds', 'sort.hot') }),
      }}
      onChange={() => undefined}
      disabled={disabled}
    />
  );
}

function View({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslate();
  const labels = useDensityLabels();
  const icons = { card: ViewCardIcon, classic: ViewClassicIcon, compact: ViewCompactIcon };
  const views = (['card', 'classic', 'compact'] as const).map((id) => ({ id, label: labels[id], icon: icons[id] }));
  return (
    <ViewMenu
      views={views}
      view="classic"
      labels={{ group: labels.group, current: t('feeds', 'menu.current'), trigger: t('feeds', 'header.view', { view: labels.classic }) }}
      onChange={() => undefined}
      disabled={disabled}
    />
  );
}

function RowActions({ copied = false, disabled }: { copied?: boolean; disabled?: boolean }) {
  const { t, locale } = useTranslate();
  return (
    <span className="pb-post__actions">
      <FeedRowActions
        labels={{
          more: t('feeds', 'row.more', { title: 'Which sort do you leave your home feed on?' }),
          list: t('feeds', 'row.list'),
          copy: t('feeds', 'row.copy'),
        }}
        publishedAt="2026-11-03T23:30:00.000Z"
        locale={locale}
        onCopy={() => undefined}
        status={copied ? t('feeds', 'row.copied') : ''}
        disabled={disabled}
      />
    </span>
  );
}

function End({ state }: { state: FeedEndState }) {
  const { t } = useTranslate();
  return (
    <div className="pb-rows">
      <FeedEnd
        state={state}
        density="classic"
        labels={{ failed: t('feeds', 'more.failed'), retry: t('feeds', 'more.retry'), end: t('feeds', 'end') }}
        onRetry={() => undefined}
        fallback={<Link href="/all?cursor=sample">{t('feeds', 'next')}</Link>}
      />
      {/* At the end of a list opened at a later page (an address with a cursor), the way back to its first. */}
      {state === 'end' && <Pager aria-label={t('feeds', 'pages.label')} first={{ href: '/all', label: t('feeds', 'first') }} />}
    </div>
  );
}

function Skip({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslate();
  return <FeedSkip label={t('feeds', 'skip')} onSkip={() => undefined} disabled={disabled} shown />;
}

export const feedPieces: Readonly<Record<string, Composition>> = {
  'feed-sort-menu': {
    name: 'Feed header, Sort',
    states: { rest: () => <Sort />, selected: () => <Sort top />, disabled: () => <Sort disabled /> },
  },
  'feed-view-menu': { name: 'Feed header, View', states: { rest: () => <View />, disabled: () => <View disabled /> } },
  'feed-row-actions': {
    name: 'Feed row, Copy link and its confirmation',
    states: { rest: () => <RowActions />, selected: () => <RowActions copied />, disabled: () => <RowActions disabled /> },
  },
  'feed-retry': { name: 'Feed end, Retry', states: { rest: () => <End state="failed" />, pending: () => <End state="pending" /> } },
  'feed-end': { name: 'Feed end, everything loaded', states: { rest: () => <End state="end" /> } },
  'feed-skip': { name: 'Skip past the posts', states: { rest: () => <Skip />, disabled: () => <Skip disabled /> } },
};
