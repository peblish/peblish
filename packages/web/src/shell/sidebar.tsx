import { unreadCap } from '@peblish/core/notifications/view';
import type { SessionView } from '@peblish/schema/session';
import type { ActorRef } from '@peblish/schema/views';
import { Avatar } from '@peblish/ui/components/avatar';
import { avatarInitial } from '@peblish/ui/components/avatar-initial.ts';
import { neutraliseBidi } from '@peblish/ui/components/handle';
import {
  CircleHelpIcon,
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
import { Menu } from '@peblish/ui/components/menu';
import { Sidebar } from '@peblish/ui/components/sidebar';
import { Text } from '@peblish/ui/components/text';
import { Tooltip } from '@peblish/ui/components/tooltip';
import { useRouter } from '@tanstack/react-router';
import { useMemo, type ComponentType, type ReactNode } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { openInRouter } from './client-links.ts';
import type { ShellData } from './data.ts';
import { communityPath, directoryPaths, feedPaths, reportQueuePath, sitePaths } from './paths.ts';
import { useSectionFolds, type SideSection } from './side-state.ts';
// The Saved page's entry (saves lane).
import { BookmarkIcon } from '@peblish/ui/components/icons';
import { savedPath } from './paths.ts';

/** A count as the badges print it: "99+" from the cap on. */
export const badgeText = (count: number) => (count >= unreadCap ? `${unreadCap - 1}+` : String(count));

/**
 * A community's name in the sidebar: its display name, else its name, without its directional controls; the
 * row isolates it (<bdi>), as display names from other servers are shown everywhere (BidiText).
 */
const communityLabel = (community: ActorRef) => neutraliseBidi(community.displayName?.trim() || community.name, '');

// A community's row draws a small Mux Avatar with its initial (the label's first character, whole) as
// Sidebar.NavItem's icon, which is a component: the shell's data has no community pictures yet, and folded into
// the rail the row keeps a mark and its tooltip.
const iconOf = (initial: string): ComponentType<{ className?: string }> =>
  function CommunityInitial({ className }: { className?: string }) {
    return (
      <Avatar.Root size="sm" className={`${className ?? ''} pb-nav__avatar`} aria-hidden="true">
        <Avatar.Fallback>{initial}</Avatar.Fallback>
      </Avatar.Root>
    );
  };
export const initialIcon = (label: string) => iconOf(avatarInitial(label, ''));

/** A community's row: its icon made once for the row and its initial, so the row keeps it across renders. */
function CommunityItem({ label, href, current }: { label: string; href: string; current: boolean }) {
  const initial = avatarInitial(label, '');
  const icon = useMemo(() => iconOf(initial), [initial]);
  return (
    <Sidebar.NavItem href={href} icon={icon} current={current}>
      {/* An element with the text as its child, so Mux still reads the folded rail's tooltip from it. */}
      <bdi>{label}</bdi>
    </Sidebar.NavItem>
  );
}

/** The site's own pages, in the sidebar's last section and, folded, in the rail's foot menu. */
export type SitePage = { href: string; label: string; icon: ComponentType<IconProps> };

/**
 * Folded into the icon rail, the site's pages are one menu at the rail's foot (Mux's Sidebar.Footer, which
 * stays in view while the rail scrolls), named by the site and by a tooltip, as Commons has it, rather than
 * four more icons. With scripts off the menu cannot open, so shell.css shows the section in the rail instead.
 */
export function SiteMenu({ siteName, pages }: { siteName: string; pages: readonly SitePage[] }) {
  const router = useRouter();
  return (
    <Sidebar.Footer className="pb-side__foot">
      <Menu.Root>
        <Tooltip
          placement="end"
          content={siteName}
          trigger={
            <Menu.Trigger className="pb-side__site" aria-label={siteName}>
              <CircleHelpIcon />
            </Menu.Trigger>
          }
        />
        <Menu.Popup placement="end-bottom">
          <Menu.List aria-label={siteName}>
            {pages.map(({ href, label, icon: Icon }) => (
              <Menu.Item key={href} id={href} textValue={label} onAction={() => openInRouter(router, href)}>
                <span className="pb-side__site-item">
                  <Icon />
                  {label}
                </span>
              </Menu.Item>
            ))}
          </Menu.List>
        </Menu.Popup>
      </Menu.Root>
    </Sidebar.Footer>
  );
}

/**
 * The sidebar's navigation (Commons): the feeds; Moderation (the queue, for moderators and admins); the
 * viewer's communities (a signed-out visitor's: the local ones), A to Z by name, then the directory; and
 * the site's own pages under the site's name. Mux's NavList names the landmark (`navLabel`). The shell
 * renders it in the column, where its sections fold (`foldable`, remembered in this browser) and, folded
 * into the rail (`folded`), the site's pages move to the foot menu; and in the phone drawer, where `extra`
 * adds the account's section and nothing folds, as Commons has it. Each marks the current page itself.
 * Pinned communities arrive with their data in a later branch: they go first in the Communities section,
 * then a Sidebar.NavDivider when unpinned rows follow, and a row's own control (Unpin, a menu) is
 * Sidebar.NavItem's `action` (the gallery's sidebar page lays both out).
 */
export function Navigation({
  session,
  shell,
  pathname,
  extra,
  foldable = false,
  folded = false,
}: {
  session: SessionView | null;
  shell: ShellData;
  pathname: string;
  extra?: ReactNode;
  foldable?: boolean;
  folded?: boolean;
}) {
  const { t, locale } = useTranslate();
  const folds = useSectionFolds();
  // Every item has an icon: without one Mux draws the label's first letter, which is in the link's text.
  const item = (href: string, label: string, icon: ComponentType<IconProps>, badge?: ReactNode) => (
    <Sidebar.NavItem key={href} href={href} icon={icon} current={pathname === href} badge={badge}>
      {label}
    </Sidebar.NavItem>
  );
  // A section's title is a button that folds it, in the column; never closed in the server's page.
  const section = (id: SideSection, label: string) =>
    foldable
      ? { label, collapsible: true, expanded: folds.isOpen(id), onExpandedChange: (open: boolean) => folds.setOpen(id, open) }
      : { label };
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
  const sitePages: readonly SitePage[] = [
    { href: sitePaths.about, label: t('shell', 'footer.about'), icon: InfoIcon },
    { href: sitePaths.rules, label: t('shell', 'footer.conduct'), icon: HeartHandshakeIcon },
    { href: sitePaths.privacy, label: t('shell', 'footer.privacy'), icon: LockIcon },
    { href: sitePaths.terms, label: t('shell', 'footer.terms'), icon: FileTextIcon },
  ];

  return (
    <>
      <Sidebar.NavList className="pb-nav" navLabel={t('shell', 'nav.label')}>
        {session && item(feedPaths.subscribed, t('shell', 'feed.subscribed'), HouseIcon)}
        {item(feedPaths.local, t('shell', 'feed.local'), MapPinIcon)}
        {item(feedPaths.all, t('shell', 'feed.all'), GlobeIcon)}
        {item(feedPaths.popular, t('shell', 'feed.popular'), FlameIcon)}
        {session && shell.moderating > 0 && item(feedPaths.moderating, t('shell', 'feed.moderating'), ShieldIcon)}
        {session && item(savedPath, t('saves', 'nav'), BookmarkIcon)}
        {shell.reportCount !== null && (
          <Sidebar.Section {...section('moderation', t('shell', 'nav.moderation'))}>
            {item(reportQueuePath(), t('shell', 'you.queue'), ClipboardListIcon, count(shell.reportCount, t('shell', 'you.open')))}
          </Sidebar.Section>
        )}
        <Sidebar.Section {...section('communities', t('shell', 'nav.communities'))}>
          {communities.map(({ community, label }) => {
            const href = communityPath(community);
            return <CommunityItem key={community.id} label={label} href={href} current={pathname === href} />;
          })}
          {item(directoryPaths.browse, t('shell', 'communities.browse'), CompassIcon)}
        </Sidebar.Section>
        <Sidebar.Section className="pb-nav__site" {...section('site', shell.siteName)}>
          {sitePages.map(({ href, label, icon }) => item(href, label, icon))}
        </Sidebar.Section>
        {extra}
      </Sidebar.NavList>
      {folded && <SiteMenu siteName={shell.siteName} pages={sitePages} />}
    </>
  );
}
