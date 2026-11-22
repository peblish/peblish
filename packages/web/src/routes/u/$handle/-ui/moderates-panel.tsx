import { Handle } from '@peblish/ui/components/handle';
import { RailLinks } from '@peblish/ui/components/rail-links';
import { RailPanel } from '@peblish/ui/components/rail-panel';
import { Text } from '@peblish/ui/components/text';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { communityPath } from '../../../../shell/paths.ts';
import type { ProfileData } from '../-load.ts';

/**
 * The profile rail's Moderates (Commons, the mock's person panels): a link to each community the
 * person moderates, as this server verified it and this viewer may see it, by handle. Left out when
 * there is none; past the list's bound it says there are more.
 */
export function ModeratesPanel({ moderates }: { moderates: ProfileData['moderates'] }) {
  const { t } = useTranslate();
  if (moderates.communities.length === 0) return null;
  return (
    <RailPanel title={t('facts', 'moderates.title')}>
      <RailLinks
        items={moderates.communities.map((community) => ({
          key: community.id,
          href: communityPath(community),
          label: <Handle prefix="!" handle={community.handle} />,
        }))}
      />
      {moderates.more && (
        <Text as="p" size="sm" color="muted">
          {t('facts', 'moderates.more')}
        </Text>
      )}
    </RailPanel>
  );
}
