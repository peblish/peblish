import { HeaderNav } from '@peblish/ui/components/header-nav';
import { Link } from '@peblish/ui/components/link';
import { Sidebar } from '@peblish/ui/components/sidebar';
import { getRouteApi, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { Account, AccountLinks } from './account.tsx';
import { CreatePost } from './create-post.tsx';
import { Brand, Navigation } from './sidebar.tsx';
import { ThemeMenu } from './theme-menu.tsx';

const root = getRouteApi('__root__');

/** Create post (signed in), Appearance and the account: the top bar's actions. The phone bar has
 * no room for Appearance, which moves into the drawer. */
function Actions({ appearance }: { appearance: boolean }) {
  const { session } = root.useLoaderData();
  return (
    <>
      {session && <CreatePost />}
      {appearance && <ThemeMenu />}
      <Account session={session} />
    </>
  );
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
 * The application frame (shell-sidebar, mock direction A): the Mux Sidebar column on the left,
 * a HeaderNav bar with the actions over the page, and the page centred in the width that is
 * left. Below 860 px the column and the bar give way to the Sidebar's phone bar, whose menu
 * button opens the same navigation in Mux's drawer (with Appearance at its foot), and the
 * other actions sit beside the brand. The drawer needs scripts. Each route renders its own
 * <main>; the frame only supplies the landmarks around it.
 *
 * The phone bar and the desktop bar each render the actions; CSS shows one of them, so
 * assistive technology and role queries only ever meet one.
 *
 * With scripts off (`@media (scripting: none)`, shell.css) the menu, the popover and the drawer
 * cannot open: the account's button becomes a link to the account list under the page
 * (AccountLinks), Appearance is hidden, and on phones the drawer's button gives way to the
 * Sidebar column itself, laid out under the page. A browser that does not know the media feature
 * gets the scripted layout.
 *
 * On the phone bar the brand and the actions sit beside Sidebar.MobileTrigger, laid over its
 * bar by CSS, not in its `logo` slot: that slot is inside React Aria's DialogTrigger, whose press
 * handler every pressable inside inherits, so a tap on Account (or on the brand on its own page)
 * would open the drawer too. The trigger sits in a <section> so its <header> is not a second
 * banner beside the bar's own.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { session, shell } = root.useLoaderData();
  const { t } = useTranslate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useFocusLostToPage(useRouterState({ select: (state) => state.resolvedLocation?.pathname }));
  const navigation = <Navigation session={session} shell={shell} pathname={pathname} />;

  return (
    <Sidebar.Provider>
      <div className="pb-app">
        <Link className="pb-skip pb-link-quiet" href="#pb-main">
          {t('shell', 'skip')}
        </Link>
        <header className="pb-app__bar">
          <div className="pb-app__bar-start">
            <Brand siteName={shell.siteName} className="pb-bar-brand" />
            <span className="pb-app__actions">
              <Actions appearance={false} />
            </span>
          </div>
          <section className="pb-app__menu">
            {/* Keyed by the page, so a navigation (a link tap in the drawer, Back or Forward) closes the drawer. */}
            <Sidebar.MobileTrigger key={pathname}>
              {navigation}
              <div className="pb-app__drawer-foot">
                <ThemeMenu />
              </div>
            </Sidebar.MobileTrigger>
          </section>
        </header>
        <div className="pb-app__side">
          <Sidebar.Root className="pb-side" hideBorder aria-label={t('shell', 'sidebar.label')}>
            <Sidebar.Header>
              <Brand siteName={shell.siteName} />
            </Sidebar.Header>
            {navigation}
          </Sidebar.Root>
        </div>
        <div className="pb-app__body">
          {/* HeaderNav is an inverse bar; its controls take the dark scheme so they read on it in both schemes. */}
          <div className="pb-top" data-muxui-color-scheme="dark">
            <HeaderNav.Root>
              <HeaderNav.Actions>
                <Actions appearance />
              </HeaderNav.Actions>
            </HeaderNav.Root>
          </div>
          <div id="pb-main" className="pb-app__content" tabIndex={-1}>
            {children}
          </div>
          {session && <AccountLinks session={session} />}
        </div>
      </div>
    </Sidebar.Provider>
  );
}
