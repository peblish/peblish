import { unreadCap } from '@peblish/core/notifications/view';
import type { SessionView } from '@peblish/schema/session';
import type { BrandPack } from '@peblish/ui/brand/pack.ts';
import { FinderPending } from '@peblish/ui/components/community-finder-pending';
import { CountBadge } from '@peblish/ui/components/count-badge';
import { HeaderNav } from '@peblish/ui/components/header-nav';
import { InboxIcon, SearchIcon } from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { getRouteApi } from '@tanstack/react-router';
import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { Account, SignedOutActions } from './account.tsx';
import { Brand } from './brand.tsx';
import { CreatePost } from './create-post.tsx';
import type { ShellData } from './data.ts';
import { directoryPaths, inboxPath } from './paths.ts';
import { badgeText } from './sidebar.tsx';
import { ThemeMenu } from './theme-menu.tsx';

// The finder's popup, its data and Mux's CommandPalette load when it is first wanted, so no page pays for them
// before then; pointing at the link or focusing it starts the load early.
const loadFinder = () => import('./finder/finder.tsx');
type FinderView = Awaited<ReturnType<typeof loadFinder>>['default'];
const root = getRouteApi('__root__');

/**
 * Find a community. A link to the directory, whose search is the community search, so with scripts off (or a
 * modified click: a new tab) it is that page. Otherwise a press opens the finder over the page (finder/finder.tsx),
 * which returns focus here when it closes; until its code is in, a press shows it loading (FinderPending), and code
 * that cannot load leaves for the directory, as the link would. In the header it reads as a search field with its name in it, a visible
 * label, not a placeholder; on the phone's top bar (`compact`) it is the search icon alone, named for assistive tech.
 */
export function FindLink({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslate();
  const label = t('shell', 'find');
  const [open, setOpen] = useState(false);
  // The finder's code, once loaded.
  const [Finder, setFinder] = useState<FinderView | null>(null);
  const load = () => loadFinder().then(({ default: loaded }) => setFinder(() => loaded));
  // Who the finder is for: another account (or none) gets a new finder, with nothing of the last one's (its text,
  // its rows and their follows, a request on its way).
  const viewer = root.useLoaderData({ select: ({ session }) => session?.actorId ?? '' });
  // It opens a popup only once the page has hydrated; before then, and with scripts off, it is a plain link.
  const hydrated = useHydrated();
  const opener = {
    href: directoryPaths.browse,
    'aria-haspopup': hydrated ? ('dialog' as const) : undefined,
    // A load that fails here is tried again by a press.
    onPointerEnter: () => void load().catch(() => undefined),
    onFocus: () => void load().catch(() => undefined),
    // A plain link: the page's client-link listener (shell/client-links.ts) skips a click this prevented.
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      const modified = event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (modified || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(true);
      load().catch(() => {
        setOpen(false);
        window.location.assign(directoryPaths.browse);
      });
    },
    // Focus stays here while the finder loads: Escape lets it go.
    onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => {
      if (event.key === 'Escape' && open && !Finder) setOpen(false);
    },
  };
  return (
    <>
      {compact ? (
        <Link className="pb-find pb-find--compact pb-link-quiet" aria-label={label} {...opener}>
          <SearchIcon className="pb-find__icon" />
        </Link>
      ) : (
        <Link className="pb-find pb-link-quiet" {...opener}>
          <SearchIcon className="pb-find__icon" />
          <Text className="pb-find__text">{label}</Text>
        </Link>
      )}
      {open &&
        (Finder ? (
          <Finder key={viewer} onClose={() => setOpen(false)} />
        ) : (
          <FinderPending label={t('finder', 'placeholder')} loading={t('finder', 'loading')} />
        ))}
    </>
  );
}

/**
 * The inbox in the desktop header: its icon and name, and the unread count after the name, a CountBadge
 * read as "3 unread" (so the link reads "Inbox 3 unread"), current on the inbox's page.
 */
export function InboxLink({ unread, current }: { unread: number; current: boolean }) {
  const { t, locale } = useTranslate();
  return (
    <HeaderNav.NavButton className="pb-top__link" href={inboxPath} current={current}>
      <InboxIcon className="pb-top__icon" />
      <Text className="pb-top__label">{t('shell', 'you.inbox')}</Text>
      <CountBadge count={unread} max={unreadCap - 1} locale={locale} label={`${badgeText(unread)} ${t('shell', 'you.unread')}`} />
    </HeaderNav.NavButton>
  );
}

/**
 * The desktop header (Commons): Mux HeaderNav on the page's own surface across the full width, a hairline
 * under it. The brand at the start, the finder in the middle of the window, and at the end Create post,
 * the inbox and the account menu (which holds Appearance); a visitor gets Appearance, Sign in and Sign up.
 * Below 860 px the phone's top and bottom bars take its place (shell.css).
 */
export function TopHeader({
  session,
  shell,
  pack,
  pathname,
}: {
  session: SessionView | null;
  shell: ShellData;
  pack: BrandPack | null;
  pathname: string;
}) {
  return (
    <div className="pb-top">
      <HeaderNav.Root variant="background" aria-label={shell.siteName}>
        <HeaderNav.Logo className="pb-top__logo">
          <Brand siteName={shell.siteName} pack={pack} className="pb-brand" />
        </HeaderNav.Logo>
        <div className="pb-top__find">
          <FindLink />
        </div>
        <HeaderNav.Actions className="pb-top__actions">
          {session ? (
            <>
              <CreatePost />
              <InboxLink unread={shell.unread} current={pathname === inboxPath} />
              <Account session={session} />
            </>
          ) : (
            <>
              <ThemeMenu />
              <SignedOutActions />
            </>
          )}
        </HeaderNav.Actions>
      </HeaderNav.Root>
    </div>
  );
}
