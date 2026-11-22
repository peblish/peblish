import type { CommunityGroup } from '@peblish/core/reports/groups';
import type { QueueTab } from '@peblish/core/reports/scope';
import { BidiText, Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { translatePlural } from '../../../../i18n/translate.ts';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { communityPath } from '../../../../shell/paths.ts';
import type { QueueView } from '../-href.ts';
import { QueueTable } from './queue.tsx';

/** The words for a community's count under each tab: what its groups are there. */
const countKey = {
  open: 'queue.count.open',
  escalated: 'queue.count.escalated',
  admins: 'queue.count.open',
  resolved: 'queue.count.resolved',
  dismissed: 'queue.count.dismissed',
} as const;

/**
 * The queue by community (Commons' moderation queue): one section per community, named by its
 * heading (the community's name, a link to it, and how many groups it holds under this tab in all),
 * over the queue's own table of its rows on this page. A community with nothing waiting says so.
 * The admins' own reports (people, and the admins-only categories) are one section with no
 * community, which only an admin is ever sent.
 */
export function QueueGroups({
  groups,
  tab,
  admin,
  view,
  now,
}: {
  groups: readonly CommunityGroup[];
  tab: QueueTab;
  admin: boolean;
  view: QueueView;
  now: number;
}) {
  const { t, locale } = useTranslate();
  return (
    <div className="rq-groups">
      {groups.map((group) => {
        const id = `rq-group-${group.community?.id ?? 'admins'}`;
        return (
          <section key={id} className="rq-group" aria-labelledby={id}>
            <div className="rq-group__head">
              <Text as="h2" variant="title" size="sm" id={id} className="rq-group__title">
                {group.community ? (
                  <Link href={communityPath(group.community)} className="pb-link-quiet">
                    {group.community.displayName ? (
                      <BidiText text={group.community.displayName} />
                    ) : (
                      <Handle prefix="!" handle={group.community.handle} />
                    )}
                  </Link>
                ) : (
                  t('facts', 'queue.admins')
                )}
              </Text>
              {group.community?.displayName && (
                <Text size="sm" color="muted">
                  <Handle prefix="!" handle={group.community.handle} />
                </Text>
              )}
              <Text size="sm" color="muted" className="rq-group__count">
                {translatePlural(locale, 'facts', countKey[tab], group.openCount)}
              </Text>
            </div>
            {group.rows.length > 0 ? (
              <QueueTable groups={group.rows} tab={tab} admin={admin} view={view} now={now} />
            ) : (
              <Text as="p" size="sm" color="muted">
                {t('facts', 'queue.nothing')}
              </Text>
            )}
          </section>
        );
      })}
    </div>
  );
}
