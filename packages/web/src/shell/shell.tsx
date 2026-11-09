import { MenuIcon } from '@peblish/ui/components/icons';
import { getRouteApi, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { Account } from './account.tsx';
import { CreatePost } from './create-post.tsx';
import { useMenuDismiss } from './menu-dismiss.ts';
import { Sidebar } from './sidebar.tsx';
import { ThemeMenu } from './theme-menu.tsx';

const root = getRouteApi('__root__');

/**
 * The application frame (shell-sidebar): a persistent sidebar on the left, a top bar with the
 * create-post entry, the appearance menu and the account area, and the page centred in the
 * width that is left. Below 860 px the sidebar is a drawer behind the menu button. Each
 * route renders its own <main>; the frame only supplies the landmarks around it.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { session, shell } = root.useLoaderData();
  const { t } = useTranslate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The drawer is open for the page it was opened on: a navigation closes it without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const drawer = openAt === pathname;
  const setDrawer = (open: boolean) => setOpenAt(open ? pathname : null);
  const frame = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);

  useMenuDismiss(frame, pathname);

  // The drawer is modal while open: focus goes in and Escape closes it; focus returns to the button.
  useEffect(() => {
    if (drawer) {
      opened.current = true;
      frame.current?.querySelector<HTMLElement>('.pb-side__close')?.focus();
      const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpenAt(null);
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }
    if (opened.current) {
      opened.current = false;
      menuButton.current?.focus();
    }
  }, [drawer]);

  return (
    <div className="pb-app" ref={frame} data-drawer={drawer || undefined}>
      <a className="pb-skip" href="#pb-main">
        {t('shell', 'skip')}
      </a>
      <Sidebar session={session} shell={shell} pathname={pathname} open={drawer} onClose={() => setDrawer(false)} />
      <div className="pb-app__body" inert={drawer || undefined}>
        <header className="pb-top">
          <button
            type="button"
            ref={menuButton}
            className="pb-top__menu"
            aria-label={t('shell', 'menu.open')}
            aria-expanded={drawer}
            aria-controls="pb-side"
            onClick={() => setDrawer(true)}
          >
            <MenuIcon />
          </button>
          <span className="pb-top__space" />
          {session && <CreatePost />}
          <ThemeMenu />
          <Account session={session} />
        </header>
        <div id="pb-main" className="pb-app__content" tabIndex={-1}>
          {children}
        </div>
      </div>
      {drawer && <div className="pb-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
    </div>
  );
}
