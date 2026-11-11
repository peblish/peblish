import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { Handle, neutraliseBidi } from '@peblish/ui/components/handle';
import { Table } from '@peblish/ui/components/table';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { translatePlural } from '../../../../i18n/translate.ts';
import { useDate } from '../../../auth/-ui/page.tsx';
import { Badge } from '@peblish/ui/components/badge';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Notice } from '@peblish/ui/components/notice';
import { SettingsLayout } from '../../account/-nav.tsx';
import type { BlocksData } from '../-load.ts';
import { blockTabs, blocksPath, kindOfTab, type BlocksSearch } from '../-tabs.ts';
import { BlockForm } from './block-form.tsx';
import { blockError } from './errors.ts';

const prefixOf = { person: '@', community: '!', instance: '' } as const;

/** The page after blocks-tabs.html: three tabs as links, an explanation and an add field for the open one, then its list. */
export function BlocksPage({ data, search }: { data: BlocksData; search: BlocksSearch }) {
  const { t, locale } = useTranslate();
  const date = useDate();
  const { tab } = data;
  const kind = kindOfTab[tab];
  const failure = blockError(search.error, tab, search.q);
  return (
    <SettingsLayout admin={data.admin} title={t('blocks', 'title')}>
      <LinkTabs
        aria-label={t('blocks', 'tabs.label')}
        items={blockTabs.map((name) => ({
          to: `${blocksPath}?tab=${name}`,
          active: name === tab,
          label: (
            <>
              {t('blocks', `tab.${name}`)}
              <Badge>{data.counts[kindOfTab[name]]}</Badge>
            </>
          ),
        }))}
      />

      <section aria-label={t('blocks', `tab.${tab}`)} className="settings__main">
        <Text as="p">
          <Text variant="label" size="md">
            {t('blocks', `${tab}.lead`)}
          </Text>{' '}
          {t('blocks', `${tab}.body`)}
        </Text>

        {data.just && (
          <Notice
            tone="success"
            role="status"
            action={
              <BlockForm kind={kind} fields={{ intent: 'remove', kind, target: data.just.id }}>
                <Button type="submit" variant="ghost" size="sm">
                  {t('blocks', 'just.undo')}
                </Button>
              </BlockForm>
            }
          >
            {t('blocks', 'just', { name: data.just.name })}
          </Notice>
        )}

        {/* An error from a form posted without scripts; the enhanced form shows its own beside the field. */}
        {failure && (
          <Notice tone="danger" role="alert">
            {t('blocks', failure.key, failure.params)}
          </Notice>
        )}

        <BlockForm kind={kind} className="blk-add" fields={{ intent: 'add', kind }}>
          <TextField
            label={t('blocks', `${tab}.field`)}
            name="handle"
            required
            autoComplete="off"
            placeholder={t('blocks', `${tab}.placeholder`)}
            defaultValue={search.error ? search.q : undefined}
            className="blk-add__field"
          />
          <Button type="submit" variant="primary">
            {t('blocks', 'add')}
          </Button>
        </BlockForm>

        {data.rows.length === 0 ? (
          <EmptyState title={t('blocks', `${tab}.emptyTitle`)}>{t('blocks', `${tab}.empty`)}</EmptyState>
        ) : (
          <Card.Root padding="sm" className="blk-list">
            <Table
              aria-label={t('blocks', 'list.label', { kind: t('blocks', `tab.${tab}`) })}
              columns={[
                { id: 'name', label: t('blocks', 'column.name'), isRowHeader: true },
                { id: 'details', label: t('blocks', 'column.details') },
                { id: 'actions', label: t('blocks', 'column.actions') },
              ]}
              rows={data.rows.map((row) => ({
                id: row.id,
                textValue: row.handle,
                values: {
                  name: kind === 'instance' ? neutraliseBidi(row.handle) : <Handle prefix={prefixOf[kind]} handle={row.handle} />,
                  details: (
                    <Text size="sm" color="muted" className="blk-details">
                      {t('blocks', 'row.blocked', { date: date(row.blockedAt) })}
                      {row.hides &&
                        ` · ${t('blocks', 'row.hides', {
                          people: translatePlural(locale, 'blocks', 'row.people', row.hides.people),
                          communities: translatePlural(locale, 'blocks', 'row.communities', row.hides.communities),
                        })}`}
                    </Text>
                  ),
                  actions: (
                    <BlockForm kind={kind} fields={{ intent: 'remove', kind, target: row.id }}>
                      <Button
                        type="submit"
                        variant="neutral"
                        size="sm"
                        aria-label={`${t('blocks', 'remove')} ${prefixOf[kind]}${neutraliseBidi(row.handle)}`}
                      >
                        {t('blocks', 'remove')}
                      </Button>
                    </BlockForm>
                  ),
                },
              }))}
            />
          </Card.Root>
        )}
      </section>
    </SettingsLayout>
  );
}
