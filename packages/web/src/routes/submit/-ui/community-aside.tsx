import { Card } from '@peblish/ui/components/card';
import { Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { Prose } from '@peblish/ui/components/prose';
import { RailPanel } from '@peblish/ui/components/rail-panel';
import { Text } from '@peblish/ui/components/text';
import { useTranslate } from '../../../i18n/use-translate.ts';
import type { CommunityPanel } from '../-types.ts';

/**
 * The chosen community's summary, posting warning and rules. Each rule's title and text are shown in
 * full: they are what a poster must read, and a closed Mux Disclosure would hide the text until
 * scripts run.
 */
function RulesBody({ panel }: { panel: CommunityPanel }) {
  const { t } = useTranslate();
  return (
    <>
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
    </>
  );
}

/** The rules beside the form in the composer sheet: an outlined Mux Card in the sheet's second column. */
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
              <RulesBody panel={panel} />
            </Card.Body>
          </>
        )}
      </Card.Root>
    </aside>
  );
}

/**
 * The rules on Create post's page (Commons): a RailPanel named by the community, in the frame's right
 * rail, or under the community picker where the page is too narrow for the rail. The page puts it in a
 * landmark of its own (the rail's aside, or one under the picker).
 */
export function CommunityRules({ panel, loading }: { panel: CommunityPanel | null; loading: boolean }) {
  const { t } = useTranslate();
  if (panel === null)
    return (
      <RailPanel className="cmp__panel">
        <Text as="p" color="muted">
          {loading ? t('composer', 'panel.loading') : t('composer', 'panel.choose')}
        </Text>
      </RailPanel>
    );
  return (
    <RailPanel title={<Handle prefix="!" handle={panel.handle} />} className="cmp__panel">
      <RulesBody panel={panel} />
    </RailPanel>
  );
}
