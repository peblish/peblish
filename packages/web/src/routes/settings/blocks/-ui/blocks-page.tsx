import { Button } from '@peblish/ui/components/button';
import { Handle } from '@peblish/ui/components/handle';
import { Link } from '@tanstack/react-router';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { translatePlural } from '../../../../i18n/translate.ts';
import { useDate } from '../../../auth/-ui/page.tsx';
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
    <SettingsLayout admin={data.admin}>
      <h1>{t('blocks', 'title')}</h1>
      <nav className="blk-tabs" aria-label={t('blocks', 'tabs.label')}>
        {blockTabs.map((name) => (
          <Link key={name} to={blocksPath} search={{ tab: name }} aria-current={name === tab ? 'page' : undefined}>
            {t('blocks', `tab.${name}`)}
            <span className="blk-count">{data.counts[kindOfTab[name]]}</span>
          </Link>
        ))}
      </nav>

      <section aria-label={t('blocks', `tab.${tab}`)}>
        <p>
          <b>{t('blocks', `${tab}.lead`)}</b> {t('blocks', `${tab}.body`)}
        </p>

        {data.just && (
          // A div: it holds the Undo form, which a <p> cannot contain.
          <div className="blk-note" role="status">
            {t('blocks', 'just', { name: data.just.name })}{' '}
            <BlockForm kind={kind} fields={{ intent: 'remove', kind, target: data.just.id }}>
              <button type="submit" className="pb-linkbutton">
                {t('blocks', 'just.undo')}
              </button>
            </BlockForm>
          </div>
        )}

        {/* An error from a form posted without scripts; the enhanced form shows its own beside the field. */}
        {failure && (
          <p className="blk-error" role="alert">
            {t('blocks', failure.key, failure.params)}
          </p>
        )}

        <BlockForm kind={kind} className="blk-add" fields={{ intent: 'add', kind }}>
          <label htmlFor="blk-handle">{t('blocks', `${tab}.field`)}</label>
          <div className="blk-add-row">
            <input
              id="blk-handle"
              name="handle"
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t('blocks', `${tab}.placeholder`)}
              defaultValue={search.error ? search.q : undefined}
            />
            <Button type="submit" variant="primary">
              {t('blocks', 'add')}
            </Button>
          </div>
        </BlockForm>

        {data.rows.length === 0 ? (
          <p className="blk-empty">{t('blocks', `${tab}.empty`)}</p>
        ) : (
          <ul className="blk-list" aria-label={t('blocks', 'list.label', { kind: t('blocks', `tab.${tab}`) })}>
            {data.rows.map((row) => (
              <li key={row.id} className="blk-row">
                <span className="blk-name">
                  {kind === 'instance' ? row.handle : <Handle prefix={prefixOf[kind]} handle={row.handle} />}
                </span>
                <span className="blk-meta">
                  {t('blocks', 'row.blocked', { date: date(row.blockedAt) })}
                  {row.hides &&
                    ` · ${t('blocks', 'row.hides', {
                      people: translatePlural(locale, 'blocks', 'row.people', row.hides.people),
                      communities: translatePlural(locale, 'blocks', 'row.communities', row.hides.communities),
                    })}`}
                </span>
                <BlockForm kind={kind} fields={{ intent: 'remove', kind, target: row.id }}>
                  <Button type="submit" variant="neutral" aria-label={`${t('blocks', 'remove')} ${prefixOf[kind]}${row.handle}`}>
                    {t('blocks', 'remove')}
                  </Button>
                </BlockForm>
              </li>
            ))}
          </ul>
        )}
      </section>
    </SettingsLayout>
  );
}
