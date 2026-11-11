import type { PageRow } from '@peblish/core/pages/read';
import { Badge } from '@peblish/ui/components/badge';
import { Text } from '@peblish/ui/components/text';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useDate } from '../../auth/-ui/page.tsx';

/** One language's status: Published with its date and editor, Unpublished changes, Draft or Not added. */
export function StatusCell({ row }: { row: PageRow }) {
  const { t } = useTranslate();
  const date = useDate();
  if (row.status === 'missing')
    return (
      <Text size="sm" color="muted">
        {t('admin', 'pages.status.missing')}
      </Text>
    );
  if (row.status === 'draft') return <Badge tone="neutral">{t('admin', 'pages.status.draft')}</Badge>;
  const published = row.published;
  return (
    <>
      {row.status === 'changed' && <Badge tone="warning">{t('admin', 'pages.status.changed')}</Badge>}
      {published && (
        <Text size="sm">
          {published.by
            ? t('admin', 'pages.status.published', { date: date(published.at), name: published.by })
            : t('admin', 'pages.status.publishedBy.none', { date: date(published.at) })}
        </Text>
      )}
    </>
  );
}
