import { HeaderNav } from '@peblish/ui/components/header-nav';
import { Sidebar } from '@peblish/ui/components/sidebar';
import { getRouteApi, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { Account } from './account.tsx';
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
 * The application frame (shell-sidebar, mock direction A): the Mux Sidebar column on the left,
 * a HeaderNav bar with the actions over the page, and the page centred in the width that is
 * left. Below 860 px the column and the bar give way to the Sidebar's phone bar, whose menu
 * button opens the same navigation in Mux's drawer (with Appearance at its foot), and the
 * other actions sit beside the brand. The drawer needs scripts. Each route renders its own
 * <main>; the frame only supplies the landmarks around it.
 *
 * The phone bar and the desktop bar each render the actions; CSS shows one of them, so
 * assistive technology and role queries only ever meet one.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { session, shell } = root.useLoaderData();
  const { t } = useTranslate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigation = <Navigation session={session} shell={shell} pathname={pathname} />;

  return (
    <Sidebar.Provider>
      <div className="pb-app">
        <a className="pb-skip" href="#pb-main">
          {t('shell', 'skip')}
        </a>
        <div className="pb-app__bar">
          {/* Keyed by the page, so a navigation (a link tap in the drawer, Back or Forward) closes the drawer. */}
          <Sidebar.MobileTrigger
            key={pathname}
            logo={
              <>
                <Brand siteName={shell.siteName} className="pb-bar-brand" />
                <span className="pb-app__actions">
                  <Actions appearance={false} />
                </span>
              </>
            }
          >
            {navigation}
            <div className="pb-app__drawer-foot">
              <ThemeMenu />
            </div>
          </Sidebar.MobileTrigger>
        </div>
        <div className="pb-app__side">
          <Sidebar.Root className="pb-side" aria-label={t('shell', 'sidebar.label')}>
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
        </div>
      </div>
    </Sidebar.Provider>
  );
}
