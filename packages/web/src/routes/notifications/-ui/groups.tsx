import type { InboxItem } from '@peblish/core/notifications/view';
import { Text } from '@peblish/ui/components/text';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { ReplyDrafts } from './drafts.tsx';

// The inbox's date groups (Commons' Inbox.tsx): Today, Yesterday, This week and Earlier, each a
// heading over its own list. A notice's group is its age against the page's clock (`now`, the
// loader's), as the mock reckons it, not a calendar day: the server does not know the reader's
// time zone, and the server's page and the browser's must hydrate the same.

export const noticeGroups = ['today', 'yesterday', 'week', 'earlier'] as const;
export type NoticeGroup = (typeof noticeGroups)[number];

const day = 24 * 60 * 60 * 1000;

/** Under a day old is Today, under two Yesterday, under seven This week, older Earlier. */
export function groupOf(createdAt: string, now: string): NoticeGroup {
  const age = Date.parse(now) - Date.parse(createdAt);
  return age < day ? 'today' : age < 2 * day ? 'yesterday' : age < 7 * day ? 'week' : 'earlier';
}

/** The notices in their groups, each group in the order the page lists them (newest first), empty groups left out. */
export function groupNotices<Item extends InboxItem>(items: readonly Item[], now: string): { group: NoticeGroup; items: Item[] }[] {
  const byGroup = new Map<NoticeGroup, Item[]>();
  for (const item of items) {
    const group = groupOf(item.createdAt, now);
    byGroup.set(group, [...(byGroup.get(group) ?? []), item]);
  }
  return noticeGroups.flatMap((group) => {
    const list = byGroup.get(group);
    return list ? [{ group, items: list }] : [];
  });
}

/**
 * The page's notices under their date headings; `row` draws one notice (NoticeRow). A notice that moves to the next
 * group is drawn anew in that group's list, so the replies are kept here, above the groups, by notice id (drafts.tsx).
 */
export function NoticeGroups<Item extends InboxItem>({
  items,
  now,
  row,
}: {
  items: readonly Item[];
  now: string;
  row: (item: Item) => ReactNode;
}) {
  const { t } = useTranslate();
  return (
    <ReplyDrafts>
      <div className="pb-notice-groups">
        {groupNotices(items, now).map(({ group, items: list }) => {
          const name = t('notifications', `group.${group}`);
          return (
            <section key={group} className="pb-notice-group">
              <Text as="h2" variant="label" size="sm" className="pb-notice-group__title">
                {name}
              </Text>
              <ul className="pb-rows pb-notices" aria-label={t('notifications', 'list.group', { group: name })}>
                {list.map(row)}
              </ul>
            </section>
          );
        })}
      </div>
    </ReplyDrafts>
  );
}
