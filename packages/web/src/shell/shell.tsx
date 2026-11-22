import type { SessionView } from '@peblish/schema/session';
import { brandPack } from '@peblish/ui/brand/packs.ts';
import { Button } from '@peblish/ui/components/button';
import { EdgeToggle } from '@peblish/ui/components/edge-toggle';
import {
  LogInIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldIcon,
  UserPlusIcon,
  UserRoundIcon,
  type IconProps,
} from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { Sidebar } from '@peblish/ui/components/sidebar';
import { getRouteApi, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { AccountLinks, accountPages, signOutFormId } from './account.tsx';
import { Brand } from './brand.tsx';
import type { ShellData } from './data.ts';
import { TopHeader } from './header.tsx';
import { directoryPaths, feedPaths, inboxPath, reportQueuePath } from './paths.ts';
import { useSideFold } from './side-state.ts';
import { Navigation } from './sidebar.tsx';
import { PhoneTabs } from './tab-bar.tsx';
import { ThemeMenu } from './theme-menu.tsx';
import { DefaultViewHeader, FrameContext } from './view-header.tsx';

const root = getRouteApi('__root__');

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** 'wide': the page holds a staff table, which needs the wide centre (shell.css) to sit whole on a computer. */
    centre?: 'wide';
  }
}

/**
 * After a navigation that took focus with it (a drawer link, or Back with the drawer open: the
 * drawer and its button remount closed, see below), focus the new page's main landmark rather
 * than leave it on <body>. Runs once the new page has rendered; a navigation that leaves focus
 * where it was (a sidebar link) changes nothing.
 */
function useFocusLostToPage(pathname: string | undefined) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = document.querySelector<HTMLElement>('#pb-main main') ?? document.getElementById('pb-main');
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }, [pathname]);
}

/**
 * Tap again for top (Commons): a press on one of the frame's own links to the page already shown (the
 * sidebar's, the drawer's, the phone's tabs, the brand) puts the page at its top, without loading it
 * again, and moves focus to its first post's title, else its main landmark, so the next Tab carries on
 * from the top rather than from the link used.
 */
function useTapAgainForTop() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || !link.closest('.pb-side, .pb-nav, .pb-tabbar, .pb-brand, .pb-bar-brand')) return;
      if (link.origin !== location.origin || link.pathname + link.search !== location.pathname + location.search) return;
      event.preventDefault();
      window.scrollTo({ top: 0 });
      const main = document.querySelector<HTMLElement>('#pb-main main');
      const target = main?.querySelector<HTMLElement>('.pb-post__title a[href]') ?? main;
      if (target && !target.matches('a[href]') && !target.hasAttribute('tabindex')) target.tabIndex = -1;
      target?.focus({ preventScroll: true });
    };
    // Captured on the document before the page's client-link listener, which would load the page again.
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
}

/**
 * The top destinations, which have no Back: the feeds, the inbox, the directory and the moderation queue (the
 * You page draws its own bar). A profile, the viewer's own too, is a page under them: it has Back.
 */
function isRootPage(pathname: string) {
  const roots: string[] = [...Object.values(feedPaths), inboxPath, directoryPaths.browse, reportQueuePath()];
  return roots.includes(pathname);
}

const accountIcons: Record<string, ComponentType<IconProps>> = {
  profile: UserRoundIcon,
  settings: SettingsIcon,
  security: ShieldCheckIcon,
  invites: UserPlusIcon,
  admin: ShieldIcon,
};

/**
 * The phone drawer (Mux's Sidebar.MobileTrigger): the sidebar's navigation, then the account's pages
 * (or Sign in and Sign up for a visitor), with Sign out and Appearance at its foot. It stays until the
 * bottom bar's You page holds the account and the site's pages. Keyed by the page, so a navigation (a
 * link tap in the drawer, Back or Forward) closes it.
 */
function Drawer({ session, shell, pathname }: { session: SessionView | null; shell: ShellData; pathname: string }) {
  const { t } = useTranslate();
  const entry = (id: string, href: string, label: string, icon: ComponentType<IconProps>) => (
    <Sidebar.NavItem key={id} href={href} icon={icon} current={pathname === href}>
      {label}
    </Sidebar.NavItem>
  );
  const account = (
    <Sidebar.Section label={t('shell', 'account.menu')}>
      {session
        ? accountPages(session, t).map(({ id, href, label }) => entry(id, href, label, accountIcons[id] ?? UserRoundIcon))
        : [
            entry('sign-in', '/auth/sign-in', t('shell', 'account.signIn'), LogInIcon),
            entry('sign-up', '/auth/sign-up', t('shell', 'account.signUp'), UserPlusIcon),
          ]}
    </Sidebar.Section>
  );
  return (
    <Sidebar.MobileTrigger key={pathname}>
      <Navigation session={session} shell={shell} pathname={pathname} extra={account} />
      <div className="pb-app__drawer-foot">
        {session && (
          <Button type="submit" form={signOutFormId} variant="neutral" size="sm">
            {t('shell', 'account.signOut')}
          </Button>
        )}
        <ThemeMenu />
      </div>
    </Sidebar.MobileTrigger>
  );
}

/**
 * The application frame (Commons): a full-width header (header.tsx) over the sidebar, flush to the
 * window's left edge, and the page beside it, centred in what the sidebar leaves: the centre column
 * under its sticky view header, and the right rail a route puts beside its <main> (rail.tsx). The sidebar
 * folds into Mux's icon rail; its fold is in the server render (side-state.ts). The right rail gives way
 * where the page is narrower than 62rem; below 860 px the header and the sidebar give way to the phone's
 * top bar (the view header, with the mark, the finder and the drawer's button) and its bottom bar of
 * five destinations. Each route renders its own <main>; the frame supplies the landmarks around it.
 *
 * With scripts off (`@media (scripting: none)`, shell.css) the menu, the popovers, the fold and the
 * drawer cannot open: the account's button becomes a link to the account list under the page
 * (AccountLinks), Appearance and the edge toggle are hidden, and on phones the drawer's button gives way
 * to the sidebar itself, laid out under the page. A browser that does not know the media feature gets
 * the scripted layout.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { session, shell, side } = root.useLoaderData();
  const { t } = useTranslate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // A route that renders its own view header says so (view-header.tsx), and its loading host renders one too, so
  // the default bar never shows while it loads; a page that failed shows the error page, under the default bar.
  const ownHeader = useRouterState({
    select: (state) => {
      const last = state.matches.at(-1);
      return (last?.status === 'success' || last?.status === 'pending') && last.staticData.viewHeader === 'own';
    },
  });
  const wide = useRouterState({ select: (state) => state.matches.at(-1)?.staticData.centre === 'wide' });
  useFocusLostToPage(useRouterState({ select: (state) => state.resolvedLocation?.pathname }));
  useTapAgainForTop();
  const fold = useSideFold(side);
  const pack = brandPack(shell.brand);
  const parts = {
    brand: <Brand siteName={shell.siteName} pack={pack} className="pb-bar-brand" />,
    drawer: <Drawer session={session} shell={shell} pathname={pathname} />,
  };

  return (
    <Sidebar.Provider collapsed={fold.collapsed} onCollapsedChange={fold.setCollapsed}>
      <FrameContext value={parts}>
        <div className="pb-app">
          <Link className="pb-skip pb-link-quiet" href="#pb-main">
            {t('shell', 'skip')}
          </Link>
          <TopHeader session={session} shell={shell} pack={pack} pathname={pathname} />
          <div className="pb-app__side">
            <EdgeToggle
              className="pb-app__fold"
              collapsed={fold.collapsed}
              labels={{ name: t('shell', 'sidebar.label'), collapse: t('shell', 'side.collapse'), expand: t('shell', 'side.expand') }}
            />
            <Sidebar.Root className="pb-side" aria-label={t('shell', 'sidebar.label')}>
              <Navigation session={session} shell={shell} pathname={pathname} foldable folded={fold.collapsed} />
            </Sidebar.Root>
          </div>
          <div className="pb-app__page">
            <div id="pb-main" className="pb-frame" data-centre={wide ? 'wide' : undefined} tabIndex={-1}>
              {!ownHeader && <DefaultViewHeader siteName={shell.siteName} root={isRootPage(pathname)} />}
              {children}
            </div>
          </div>
          <PhoneTabs session={session} shell={shell} pathname={pathname} />
          {session && <AccountLinks session={session} />}
        </div>
      </FrameContext>
    </Sidebar.Provider>
  );
}
