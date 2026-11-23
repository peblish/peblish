import type { InstanceRow } from '@peblish/schema/views';
import { Text } from '@peblish/ui/components/text';
import { getRouteApi } from '@tanstack/react-router';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { softwareName } from '../-software.ts';

const root = getRouteApi('__root__');

/**
 * The Instances list (Commons, the mock's InstancesView): how many servers this one federates with,
 * then one row each, its domain and its software ("Software unknown" when its NodeInfo has not
 * said). Only the two public fields reach it; nothing on it is a control.
 */
export function InstancesList({ instances }: { instances: readonly InstanceRow[] }) {
  const { t, locale } = useTranslate();
  const { shell } = root.useLoaderData();
  const site = shell.siteName;
  return (
    <>
      <Text as="p" color="muted">
        {instances.length === 0
          ? t('facts', 'instances.none', { site })
          : translatePlural(locale, 'facts', 'instances.intro', instances.length, { site })}
      </Text>
      {instances.length > 0 && (
        <ul className="instances-list" aria-label={t('facts', 'instances.list', { site })}>
          {instances.map((instance) => (
            <li key={instance.domain} className="instances-row">
              <Text variant="label" className="instances-domain">
                <bdi dir="ltr">{instance.domain}</bdi>
              </Text>
              <Text size="sm" color="muted">
                {softwareName(instance.software) ?? t('facts', 'instances.unknown')}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The public Instances page: its title, then the list. */
export function InstancesPage({ instances }: { instances: readonly InstanceRow[] }) {
  const { t } = useTranslate();
  useRouteHydrated();
  return (
    <main className="pb-page instances-page">
      <Text as="h1" variant="heading" size="md">
        {t('facts', 'instances.title')}
      </Text>
      <InstancesList instances={instances} />
    </main>
  );
}
