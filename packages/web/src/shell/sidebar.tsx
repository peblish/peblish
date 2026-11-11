import { unreadCap } from '@peblish/core/notifications/view';
import type { SessionView } from '@peblish/schema/session';
import type { ActorRef } from '@peblish/schema/views';
import { Avatar } from '@peblish/ui/components/avatar';
import { Handle, neutraliseBidi } from '@peblish/ui/components/handle';
import {
  CompassIcon,
  FlameIcon,
  GlobeIcon,
  HouseIcon,
  InboxIcon,
  MapPinIcon,
  NetworkIcon,
  SearchIcon,
  ShieldCheckIcon,
  ShieldIcon,
  UsersIcon,
  type IconProps,
} from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { Sidebar } from '@peblish/ui/components/sidebar';
import { Text } from '@peblish/ui/components/text';
import { useState, type ComponentType } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import type { ShellData } from './data.ts';
import { communityPath, directoryPaths, feedPaths, inboxPath, reportQueuePath, sitePaths } from './paths.ts';

/** A count as the badges print it: "99+" from the cap on. */
const badgeText = (count: number) => (count >= unreadCap ? `${unreadCap - 1}+` : String(count));

/**
 * The site's name, linking home: the column's header (`pb-brand`, which e2e/support/site-name.ts
 * reads, so only the column has it) and the phone bar (`pb-bar-brand`).
 */
export function Brand({ siteName, className = 'pb-brand' }: { siteName: string; className?: 'pb-brand' | 'pb-bar-brand' }) {
  return (
    <Link className={className} href="/">
      <Text variant="title" size="sm" truncate>
        {siteName}
      </Text>
    </Link>
  );
}

/**
 * The sidebar's navigation (shell-sidebar): the feeds, the viewer's inbox and queue, the
 * viewer's communities with a filter, links to the directory and the resolver, and the site's
 * pages. The shell renders it twice, in the Mux Sidebar column and in its phone drawer, so each
 * marks the current page itself.
 */
export function Navigation({ session, shell, pathname }: { session: SessionView | null; shell: ShellData; pathname: string }) {
  const { t } = useTranslate();
  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();
  const matching = (communities: readonly ActorRef[]) =>
    query === '' ? communities : communities.filter(({ handle }) => handle.toLowerCase().includes(query));
  // Every item has an icon: without one Mux draws the label's first letter, which is in the link's text.
  const item = (href: string, label: string, icon: ComponentType<IconProps>) => (
    <Sidebar.NavItem href={href} icon={icon} current={pathname === href}>
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
  // Nested rows have no icon slot (Mux draws their label only), so each community's label starts
  // with a Mux Avatar of its initial; the data carries no community icon.
  const group = (id: string, label: string, icon: ComponentType<IconProps>, communities: readonly ActorRef[]) =>
    communities.length > 0 && (
      <Sidebar.NavItem
        key={id}
        icon={icon}
        defaultExpanded
        items={communities.map((community) => {
          const href = communityPath(community);
          const label = (
            <span className="pb-nav__community">
              <Avatar.Root size="sm" aria-hidden="true">
                {/* A remote name may start with a directional control, which has no glyph to show. */}
                <Avatar.Fallback>{[...neutraliseBidi(community.name, '')][0]?.toUpperCase()}</Avatar.Fallback>
              </Avatar.Root>
              <Handle prefix="!" handle={community.handle} />
            </span>
          );
          return { id: community.id, href, current: pathname === href, label };
        })}
      >
        {label}
      </Sidebar.NavItem>
    );
  const local = matching(shell.local);
  const remote = matching(shell.remote);

  return (
    <div className="pb-nav">
      <nav aria-label={t('shell', 'nav.feeds')}>
        <Sidebar.NavList>
          {session && item(feedPaths.subscribed, t('shell', 'feed.subscribed'), HouseIcon)}
          {item(feedPaths.local, t('shell', 'feed.local'), MapPinIcon)}
          {item(feedPaths.all, t('shell', 'feed.all'), GlobeIcon)}
          {item(feedPaths.popular, t('shell', 'feed.popular'), FlameIcon)}
          {session && shell.moderating > 0 && item(feedPaths.moderating, t('shell', 'feed.moderating'), ShieldIcon)}
        </Sidebar.NavList>
      </nav>
      {session && (
        <nav aria-label={t('shell', 'nav.you')}>
          <Sidebar.NavList>
            <Sidebar.Section label={t('shell', 'nav.you')}>
              <Sidebar.NavItem
                href={inboxPath}
                icon={InboxIcon}
                current={pathname === inboxPath}
                badge={count(shell.unread, t('shell', 'you.unread'))}
              >
                {t('shell', 'you.inbox')}
              </Sidebar.NavItem>
              {shell.reportCount !== null && (
                <Sidebar.NavItem
                  href={reportQueuePath()}
                  icon={ShieldCheckIcon}
                  current={pathname === reportQueuePath()}
                  badge={count(shell.reportCount, t('shell', 'you.open'))}
                >
                  {t('shell', 'you.queue')}
                </Sidebar.NavItem>
              )}
            </Sidebar.Section>
          </Sidebar.NavList>
        </nav>
      )}
      <nav aria-label={t('shell', 'nav.communities')}>
        <Sidebar.NavList>
          <Sidebar.Section label={t('shell', 'nav.communities')}>
            {shell.local.length + shell.remote.length > 0 && (
              <li className="pb-nav__filter">
                {/* Search's change type also carries its wrapper's div events, hence the narrowing. */}
                <Sidebar.Search
                  placeholder={t('shell', 'communities.filter')}
                  value={filter}
                  onChange={({ target }) => target instanceof HTMLInputElement && setFilter(target.value)}
                />
              </li>
            )}
            {group('local', t('shell', 'communities.local', { count: local.length }), UsersIcon, local)}
            {group('remote', t('shell', 'communities.remote', { count: remote.length }), NetworkIcon, remote)}
            {item(directoryPaths.browse, t('shell', 'communities.browse'), CompassIcon)}
            {item(directoryPaths.find, t('shell', 'communities.find'), SearchIcon)}
          </Sidebar.Section>
        </Sidebar.NavList>
      </nav>
      <nav className="pb-nav__foot" aria-label={t('shell', 'footer.label')}>
        <Link href={sitePaths.rules}>{t('shell', 'footer.rules')}</Link>
        <Link href={sitePaths.terms}>{t('shell', 'footer.terms')}</Link>
        <Link href={sitePaths.privacy}>{t('shell', 'footer.privacy')}</Link>
        <Link href={sitePaths.about}>{t('shell', 'footer.about')}</Link>
      </nav>
    </div>
  );
}
