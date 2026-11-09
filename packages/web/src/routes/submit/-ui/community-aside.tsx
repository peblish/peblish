import { Prose } from '@peblish/ui/components/prose';
import { Handle } from '@peblish/ui/components/handle';
import { useTranslate } from '../../../i18n/use-translate.ts';
import type { CommunityPanel } from '../-types.ts';

/** The chosen community's rules and posting warning beside the form (composer-page). */
export function CommunityAside({ panel, loading }: { panel: CommunityPanel | null; loading: boolean }) {
  const { t } = useTranslate();
  return (
    <aside className="cmp__aside" aria-label={t('composer', 'panel.label')} aria-busy={loading}>
      {panel === null ? (
        <p className="pb-muted">{loading ? t('composer', 'panel.loading') : t('composer', 'panel.choose')}</p>
      ) : (
        <>
          <h2 className="cmp__community">
            <Handle prefix="!" handle={panel.handle} />
          </h2>
          {panel.summary && <p>{panel.summary}</p>}
          {panel.sensitive && <p className="pb-muted">{t('composer', 'panel.sensitive')}</p>}
          {panel.restricted && <p className="pb-muted">{t('composer', 'panel.restricted')}</p>}
          {panel.warning && (
            <>
              <h3>{t('composer', 'panel.warning')}</h3>
              <p>{panel.warning}</p>
            </>
          )}
          <h3>{t('composer', 'panel.rules')}</h3>
          {panel.rules.length === 0 ? (
            <p className="pb-muted">{t('composer', 'panel.noRules')}</p>
          ) : (
            <ol className="cmp__rules">
              {panel.rules.map(({ title, html }, index) => (
                <li key={`${index}-${title}`}>
                  {html ? (
                    <details>
                      <summary>{title}</summary>
                      <Prose html={html} />
                    </details>
                  ) : (
                    title
                  )}
                </li>
              ))}
            </ol>
          )}
          <p>
            <a href={panel.href}>{t('composer', 'panel.more')}</a>
          </p>
        </>
      )}
    </aside>
  );
}
