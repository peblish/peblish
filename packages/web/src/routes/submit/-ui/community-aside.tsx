import { Card } from '@peblish/ui/components/card';
import { Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { Prose } from '@peblish/ui/components/prose';
import { Text } from '@peblish/ui/components/text';
import { useTranslate } from '../../../i18n/use-translate.ts';
import type { CommunityPanel } from '../-types.ts';

/**
 * The chosen community's rules and posting warning beside the form (composer-page). Each rule's
 * title and text are shown in full: they are what a poster must read, and a closed Mux
 * Disclosure would hide the text until scripts run.
 */
export function CommunityAside({ panel, loading }: { panel: CommunityPanel | null; loading: boolean }) {
  const { t } = useTranslate();
  return (
    <aside className="cmp__aside" aria-label={t('composer', 'panel.label')} aria-busy={loading}>
      <Card.Root variant="outlined" padding="md">
        {panel === null ? (
          <Card.Body>
            <Text as="p" color="muted">
              {loading ? t('composer', 'panel.loading') : t('composer', 'panel.choose')}
            </Text>
          </Card.Body>
        ) : (
          <>
            <Card.Header>
              <Text as="h2" variant="title" size="sm">
                <Handle prefix="!" handle={panel.handle} />
              </Text>
            </Card.Header>
            <Card.Body className="cmp__aside-body">
              {panel.summary && <Text as="p">{panel.summary}</Text>}
              {panel.sensitive && (
                <Text as="p" color="muted">
                  {t('composer', 'panel.sensitive')}
                </Text>
              )}
              {panel.restricted && (
                <Text as="p" color="muted">
                  {t('composer', 'panel.restricted')}
                </Text>
              )}
              {panel.warning && (
                <>
                  <Text as="h3" variant="label" size="md">
                    {t('composer', 'panel.warning')}
                  </Text>
                  <Text as="p">{panel.warning}</Text>
                </>
              )}
              <Text as="h3" variant="label" size="md">
                {t('composer', 'panel.rules')}
              </Text>
              {panel.rules.length === 0 ? (
                <Text as="p" color="muted">
                  {t('composer', 'panel.noRules')}
                </Text>
              ) : (
                <ol className="cmp__rules">
                  {panel.rules.map(({ title, html }, index) => (
                    <li key={`${index}-${title}`} className="cmp__rule">
                      <Text as="p" variant="label" size="md">
                        {title}
                      </Text>
                      {html && <Prose html={html} />}
                    </li>
                  ))}
                </ol>
              )}
              <Link href={panel.href}>{t('composer', 'panel.more')}</Link>
            </Card.Body>
          </>
        )}
      </Card.Root>
    </aside>
  );
}
