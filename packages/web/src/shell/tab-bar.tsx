import { unreadCap } from '@peblish/core/notifications/view';
import type { SessionView } from '@peblish/schema/session';
import { Avatar } from '@peblish/ui/components/avatar';
import { BottomTabBar, type BottomTab } from '@peblish/ui/components/bottom-tab-bar';
import { CountBadge } from '@peblish/ui/components/count-badge';
import { CompassIcon, HouseIcon, InboxIcon, LogInIcon, SquarePenIcon } from '@peblish/ui/components/icons';
import { useTranslate } from '../i18n/use-translate.ts';
import type { ShellData } from './data.ts';
import { createPostPath, directoryPaths, feedPaths, inboxPath, userPath } from './paths.ts';
import { badgeText } from './sidebar.tsx';

const feeds: readonly string[] = Object.values(feedPaths);

/**
 * The phone's five destinations (Commons): Home (the feeds), Communities (the directory and the
 * communities under it), Create, the inbox with its unread count, and You, the viewer's profile; a
 * visitor's fifth is Sign in, as there is no one to be (Create and the inbox ask them to sign in too).
 * Plain links, so the bar works with scripts off; shown only on a phone (shell.css).
 */
export function PhoneTabs({ session, shell, pathname }: { session: SessionView | null; shell: ShellData; pathname: string }) {
  const { t, locale } = useTranslate();
  const at = (href: string, under = false) => pathname === href || under;
  const you = session ? userPath({ handle: session.name }) : '';
  const tabs: BottomTab[] = [
    {
      id: 'home',
      href: feedPaths.subscribed,
      label: t('shell', 'tab.home'),
      icon: <HouseIcon />,
      current: at(feedPaths.subscribed, feeds.includes(pathname)),
    },
    {
      id: 'communities',
      href: directoryPaths.browse,
      label: t('shell', 'nav.communities'),
      icon: <CompassIcon />,
      current: at(directoryPaths.browse, pathname.startsWith('/c/')),
    },
    { id: 'create', href: createPostPath, label: t('shell', 'tab.create'), icon: <SquarePenIcon />, current: at(createPostPath) },
    {
      id: 'inbox',
      href: inboxPath,
      label: t('shell', 'you.inbox'),
      icon: <InboxIcon />,
      current: at(inboxPath),
      count:
        shell.unread > 0 ? (
          <CountBadge
            count={shell.unread}
            max={unreadCap - 1}
            locale={locale}
            label={`${badgeText(shell.unread)} ${t('shell', 'you.unread')}`}
          />
        ) : undefined,
    },
    session
      ? {
          id: 'you',
          href: you,
          label: t('shell', 'nav.you'),
          icon: (
            <Avatar.Root size="sm" className="pb-app__tab-avatar">
              <Avatar.Fallback>{session.name.slice(0, 1).toUpperCase()}</Avatar.Fallback>
            </Avatar.Root>
          ),
          current: at(you),
        }
      : { id: 'sign-in', href: '/auth/sign-in', label: t('shell', 'account.signIn'), icon: <LogInIcon />, current: at('/auth/sign-in') },
  ];
  return <BottomTabBar className="pb-app__tabs" label={t('shell', 'tabs.label')} tabs={tabs} />;
}
