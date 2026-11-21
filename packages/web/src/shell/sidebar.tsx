import { unreadCap } from '@peblish/core/notifications/view';
import type { SessionView } from '@peblish/schema/session';
import type { ActorRef } from '@peblish/schema/views';
import { Avatar } from '@peblish/ui/components/avatar';
import { neutraliseBidi } from '@peblish/ui/components/handle';
import {
  ClipboardListIcon,
  CompassIcon,
  FileTextIcon,
  FlameIcon,
  GlobeIcon,
  HeartHandshakeIcon,
  HouseIcon,
  InfoIcon,
  LockIcon,
  MapPinIcon,
  ShieldIcon,
  type IconProps,
} from '@peblish/ui/components/icons';
import { Sidebar } from '@peblish/ui/components/sidebar';
import { Text } from '@peblish/ui/components/text';
import type { ComponentType, ReactNode } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import type { ShellData } from './data.ts';
import { communityPath, directoryPaths, feedPaths, reportQueuePath, sitePaths } from './paths.ts';

/** A count as the badges print it: "99+" from the cap on. */
export const badgeText = (count: number) => (count >= unreadCap ? `${unreadCap - 1}+` : String(count));

/** A community's name in the sidebar: its display name, else its name, with directional controls drawn as a mark. */
const communityLabel = (community: ActorRef) => neutraliseBidi(community.displayName?.trim() || community.name);

// A community's row draws a small Mux Avatar with its initial, as Sidebar.NavItem's icon (the shell's data
// has no community pictures yet), so folded into the rail the row keeps a mark and its tooltip. One component
// per letter, so a row keeps its icon across renders.
const initialIcons = new Map<string, ComponentType<{ className?: string }>>();
function initialIcon(label: string): ComponentType<{ className?: string }> {
  const initial = [...neutraliseBidi(label, '')][0]?.toUpperCase() ?? '';
  let Icon = initialIcons.get(initial);
  if (!Icon) {
    Icon = function CommunityInitial({ className }: { className?: string }) {
      return (
        <Avatar.Root size="sm" className={`${className ?? ''} pb-nav__avatar`} aria-hidden="true">
          <Avatar.Fallback>{initial}</Avatar.Fallback>
        </Avatar.Root>
      );
    };
    initialIcons.set(initial, Icon);
  }
  return Icon;
}

/**
 * The sidebar's navigation (Commons): the feeds; Moderation (the queue, for moderators and admins); the
 * viewer's communities (a signed-out visitor's: the local ones), A to Z by name, then the directory; and
 * the site's own pages under the site's name. One `nav` around Mux's list (Mux Sidebar has no landmark
 * option yet). The shell renders it in the column and in the phone drawer, where `extra` adds the
 * account's section, so each marks the current page itself. Pinned communities arrive with their data
 * in a later branch and go first in the Communities section.
 */
export function Navigation({
  session,
  shell,
  pathname,
  extra,
}: {
  session: SessionView | null;
  shell: ShellData;
  pathname: string;
  extra?: ReactNode;
}) {
  const { t, locale } = useTranslate();
  // Every item has an icon: without one Mux draws the label's first letter, which is in the link's text.
  const item = (href: string, label: string, icon: ComponentType<IconProps>, badge?: ReactNode) => (
    <Sidebar.NavItem key={href} href={href} icon={icon} current={pathname === href} badge={badge}>
      {label}
    </Sidebar.NavItem>
  );
  // The count's word is hidden text, so the link's name starts with what it shows (axe label-content-name-mismatch).
  const count = (value: number, word: string) =>
    value > 0 ? (
      <>
        {badgeText(value)}
        <Text className="pb-sr"> {word}</Text>
      </>
    ) : undefined;
  const collator = new Intl.Collator(locale);
  const communities = [...shell.local, ...shell.remote]
    .map((community) => ({ community, label: communityLabel(community) }))
    .sort((a, b) => collator.compare(a.label, b.label));

  return (
    <nav className="pb-nav" aria-label={t('shell', 'nav.label')}>
      <Sidebar.NavList>
        {session && item(feedPaths.subscribed, t('shell', 'feed.subscribed'), HouseIcon)}
        {item(feedPaths.local, t('shell', 'feed.local'), MapPinIcon)}
        {item(feedPaths.all, t('shell', 'feed.all'), GlobeIcon)}
        {item(feedPaths.popular, t('shell', 'feed.popular'), FlameIcon)}
        {session && shell.moderating > 0 && item(feedPaths.moderating, t('shell', 'feed.moderating'), ShieldIcon)}
        {shell.reportCount !== null && (
          <Sidebar.Section label={t('shell', 'nav.moderation')}>
            {item(reportQueuePath(), t('shell', 'you.queue'), ClipboardListIcon, count(shell.reportCount, t('shell', 'you.open')))}
          </Sidebar.Section>
        )}
        <Sidebar.Section label={t('shell', 'nav.communities')}>
          {communities.map(({ community, label }) => {
            const href = communityPath(community);
            return (
              <Sidebar.NavItem key={community.id} href={href} icon={initialIcon(label)} current={pathname === href}>
                {label}
              </Sidebar.NavItem>
            );
          })}
          {item(directoryPaths.browse, t('shell', 'communities.browse'), CompassIcon)}
        </Sidebar.Section>
        <Sidebar.Section label={shell.siteName}>
          {item(sitePaths.about, t('shell', 'footer.about'), InfoIcon)}
          {item(sitePaths.rules, t('shell', 'footer.conduct'), HeartHandshakeIcon)}
          {item(sitePaths.privacy, t('shell', 'footer.privacy'), LockIcon)}
          {item(sitePaths.terms, t('shell', 'footer.terms'), FileTextIcon)}
        </Sidebar.Section>
        {extra}
      </Sidebar.NavList>
    </nav>
  );
}
