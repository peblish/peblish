import { IconButton } from '@peblish/ui/components/icon-button';
import { ChevronLeft } from '@peblish/ui/components/icons';
import { Text } from '@peblish/ui/components/text';
import { ViewHeader as Bar } from '@peblish/ui/components/view-header';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { useCanGoBack, useRouter, useRouterState } from '@tanstack/react-router';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { FindLink } from './header.tsx';
import { pageName } from './title.ts';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /**
     * 'own': the route renders its own ViewHeader (below) at the top of its content, with its title and
     * actions, so the shell leaves out the default one it gives every other page.
     */
    viewHeader?: 'own';
  }
}

/** What the shell gives every view header: the site's mark for the phone's top bar and the phone drawer's button. */
export interface FrameParts {
  brand: ReactNode;
  drawer: ReactNode;
}

export const FrameContext = createContext<FrameParts | null>(null);

/**
 * The centre column's bar (Commons), sticky under the header; on a phone it is the top bar. Every page
 * gets one: the shell renders a default one, with the page's name from its title, unless the route says
 * `staticData: { viewHeader: 'own' }` and renders this itself with its own `title` (its h1, if the bar is
 * where the page's name lives) and `trailing` actions. `root` is a top destination (a feed, the inbox,
 * the directory, the queue, the viewer's profile), which has no Back.
 *
 * At the start: Back, once the page has hydrated and the tab's history holds a page of this site before
 * it, else on a phone the site's mark and the finder. Back needs scripts, so the server never draws it.
 * At the end on a phone: the page's actions, then the drawer's button (Mux's Sidebar.MobileTrigger),
 * which reaches the whole navigation, the account and Appearance until the You page takes those over.
 */
export function ViewHeader({
  title,
  trailing,
  root = false,
  quiet = false,
}: {
  title?: ReactNode;
  trailing?: ReactNode;
  root?: boolean;
  quiet?: boolean;
}) {
  const parts = use(FrameContext);
  const { t } = useTranslate();
  const router = useRouter();
  const hydrated = useHydrated();
  const canGoBack = useCanGoBack();
  const back = !root && hydrated && canGoBack;
  return (
    <Bar
      className="pb-frame-vh"
      leading={
        back ? (
          <IconButton variant="ghost" aria-label={t('shell', 'back')} onActivate={() => router.history.back()}>
            <ChevronLeft />
          </IconButton>
        ) : (
          <span className="pb-frame-vh__home">
            {parts?.brand}
            <FindLink compact />
          </span>
        )
      }
      title={title}
      quiet={quiet}
      trailing={
        <>
          {trailing}
          {/* A section, so Mux's own <header> around the button is not a second banner. */}
          <section className="pb-frame-vh__menu">{parts?.drawer}</section>
        </>
      }
    />
  );
}

/** The page's title as the head shows it: the deepest route's, as TanStack's HeadContent picks it. */
function headTitle(matches: readonly { meta?: readonly ({ title?: string } | undefined)[] }[]): string {
  for (const { meta } of matches.toReversed()) {
    const title = meta?.findLast((tag) => tag?.title !== undefined)?.title;
    if (title !== undefined) return title;
  }
  return '';
}

/**
 * Whether the page's own name is still in view: true until its first h1 has scrolled under the bar, and
 * on the server, so the default bar's title never doubles the page's heading; false on a page with none.
 */
function useHeadingInView(pathname: string): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const heading = document.querySelector('#pb-main main h1');
    const bar = document.querySelector('.pb-frame-vh');
    if (!bar) return;
    const line = Math.round(bar.getBoundingClientRect().bottom);
    // Without a heading the observer watches the bar, and its first report says the name is not in view.
    const observer = new IntersectionObserver(([entry]) => setInView(!!heading && !!entry && entry.boundingClientRect.bottom > line), {
      rootMargin: `-${line}px 0px 0px 0px`,
    });
    observer.observe(heading ?? bar);
    return () => observer.disconnect();
  }, [pathname]);
  return inView;
}

/**
 * The shell's view header for a page that does not render its own: the page's name from its title,
 * shown once the page's own heading has scrolled under the bar.
 */
export function DefaultViewHeader({ siteName, root }: { siteName: string; root: boolean }) {
  const title = useRouterState({ select: (state) => pageName(headTitle(state.matches), siteName) });
  const pathname = useRouterState({ select: (state) => state.resolvedLocation?.pathname ?? state.location.pathname });
  const quiet = useHeadingInView(pathname);
  return (
    <ViewHeader
      root={root}
      quiet={quiet}
      title={
        title && (
          <Text variant="label" truncate className="pb-frame-vh__title">
            {title}
          </Text>
        )
      }
    />
  );
}
