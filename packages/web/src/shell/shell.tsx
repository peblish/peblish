import { MenuIcon } from '@peblish/ui/components/icons';
import { getRouteApi, useRouter, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
 * width that is left. Below 860 px the sidebar is a drawer behind the menu link. Each
 * route renders its own <main>; the frame only supplies the landmarks around it.
 *
 * The drawer works before the page hydrates, and without scripts: the menu link goes to
 * #pb-side, which shell.css shows as a drawer through :target, and the close link and the
 * scrim go to #pb-main. Once hydrated, React takes the links over (no history entries, focus
 * handling, Escape, inert page) and adopts a drawer that was already opened that way.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { session, shell } = root.useLoaderData();
  const { t } = useTranslate();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The drawer is open for the page it was opened on: a navigation (a link tap, Back or
  // Forward) closes it, and returning to that page does not open it again.
  const [openAt, setOpenAt] = useState<string | null>(null);
  if (openAt !== null && openAt !== pathname) setOpenAt(null);
  const drawer = openAt === pathname;
  const setDrawer = (open: boolean) => setOpenAt(open ? pathname : null);
  const frame = useRef<HTMLDivElement | null>(null);
  const menuButton = useRef<HTMLAnchorElement>(null);
  const opened = useRef(false);
  const adopted = useRef(false);
  // Set once React runs the drawer: from then on shell.css ignores :target.
  const [managed, setManaged] = useState(false);

  useMenuDismiss(frame, pathname);

  // Runs when React attaches to the frame, which after hydration is the server's markup. A
  // drawer opened through the #pb-side link by then stays open: the shell takes it over once
  // and replaces the history entry the link made with one without the hash, so the URL does not
  // reopen it. The callback is stable and adopts only on the first attach, since a later one
  // (a remount) would find that dropping the hash left :target set and reopen the drawer.
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      frame.current = node;
      if (!node || adopted.current) return;
      adopted.current = true;
      if (window.location.hash === '#pb-side') {
        history.replaceState(history.state, '', window.location.pathname + window.location.search);
        setOpenAt(router.state.location.pathname);
      }
      setManaged(true);
    },
    [router],
  );

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
    <div className="pb-app" ref={attach} data-drawer={drawer || undefined} data-managed={managed || undefined}>
      <a className="pb-skip" href="#pb-main">
        {t('shell', 'skip')}
      </a>
      <Sidebar session={session} shell={shell} pathname={pathname} open={drawer} onClose={() => setDrawer(false)} />
      <div className="pb-app__body" inert={drawer || undefined}>
        <header className="pb-top">
          <a
            ref={menuButton}
            className="pb-top__menu"
            href="#pb-side"
            aria-label={t('shell', 'menu.open')}
            aria-expanded={drawer}
            aria-controls="pb-side"
            onClick={(event) => {
              event.preventDefault();
              setDrawer(true);
            }}
          >
            <MenuIcon />
          </a>
          <span className="pb-top__space" />
          {session && <CreatePost />}
          <ThemeMenu />
          <Account session={session} />
        </header>
        <div id="pb-main" className="pb-app__content" tabIndex={-1}>
          {children}
        </div>
      </div>
      <a
        className="pb-scrim"
        href="#pb-main"
        tabIndex={-1}
        aria-hidden="true"
        onClick={(event) => {
          event.preventDefault();
          setDrawer(false);
        }}
      />
    </div>
  );
}
