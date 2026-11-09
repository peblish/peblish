import type { PageRow } from '@peblish/core/pages/read';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useDate } from '../../auth/-ui/page.tsx';

/** One language's status: Published with its date and editor, Unpublished changes, Draft or Not added. */
export function StatusCell({ row }: { row: PageRow }) {
  const { t } = useTranslate();
  const date = useDate();
  if (row.status === 'missing') return <span className="muted">{t('admin', 'pages.status.missing')}</span>;
  if (row.status === 'draft') return <span>{t('admin', 'pages.status.draft')}</span>;
  const published = row.published;
  return (
    <span>
      {row.status === 'changed' ? <b className="warn-t">{t('admin', 'pages.status.changed')}</b> : null}
      {row.status === 'changed' && <br />}
      {published &&
        (published.by
          ? t('admin', 'pages.status.published', { date: date(published.at), name: published.by })
          : t('admin', 'pages.status.publishedBy.none', { date: date(published.at) }))}
    </span>
  );
}
