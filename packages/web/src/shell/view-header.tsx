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
     * actions, so the shell leaves out the default one it gives every other page. Its loading host
     * (pendingComponent), if it has one, renders one too: the shell leaves the default out while it loads.
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
 * The centre column's bar (Commons), sticky under the header; on a phone it is the top bar. A named
 * navigation landmark ("Page"), so the bar is reachable as one wherever it sits. Every page gets one:
 * the shell renders a default one, with the page's name from its title, unless the route says
 * `staticData: { viewHeader: 'own' }` and renders this itself with its own `title` (its h1, if the bar is
 * where the page's name lives), `phoneTitle` (what a phone's bar shows instead) and `trailing` actions;
 * a page whose h1 is in the page passes `quiet={useHeadingInView(pathname)}` (below) with its name as the
 * title, which then shows once that heading has scrolled under. Inside a `.pb-page` it runs the column's
 * width (shell.css). `root` is a top destination (a feed, the inbox, the directory, the queue, the You
 * page), which has no Back.
 *
 * At the start: Back, once the page has hydrated and the tab's history holds a page of this site before
 * it, else on a phone the site's mark and the finder. Back needs scripts, so the server never draws it.
 * At the end on a phone: the page's actions, then the drawer's button (Mux's Sidebar.MobileTrigger),
 * which reaches the whole navigation, the account and Appearance until the You page takes those over.
 */
export function ViewHeader({
  title,
  phoneTitle,
  trailing,
  root = false,
  quiet = false,
}: {
  title?: ReactNode;
  phoneTitle?: ReactNode;
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
  // A named navigation: the shell's own bar sits beside the route's <main>, so it needs a landmark of
  // its own, and a second <header> would be a second banner beside the site's header.
  return (
    <nav className="pb-frame-vh" aria-label={t('shell', 'bar.label')}>
      <Bar
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
        phoneTitle={phoneTitle}
        quiet={quiet}
        trailing={
          <>
            {trailing}
            {/* Inside the nav, Mux's own <header> around the button is not a second banner. */}
            <div className="pb-frame-vh__menu">{parts?.drawer}</div>
          </>
        }
      />
    </nav>
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
 * on the server, so the bar's title never doubles the page's heading; false on a page with none. Measured
 * again when `pathname` changes. For a bar's `quiet`: the default bar's, and a route's own whose h1 is in
 * the page (the inbox's).
 */
export function useHeadingInView(pathname: string): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const heading = document.querySelector('#pb-main main h1');
    const bar = document.querySelector('.pb-frame-vh');
    if (!bar) return;
    let observer: IntersectionObserver | undefined;
    let line = -1;
    let frame = 0;
    // The bar's lower edge, under which the heading counts as gone. The bar sticks inside its column, so near the
    // column's end it moves up, and a page that hydrates scrolled past that end has it above the window: then the
    // window's top, as a negative bottom would make the margin "--…px", which IntersectionObserver refuses by
    // throwing. So the edge is taken again after a scroll or a resize, and the observer made again when it moved.
    const watch = () => {
      frame = 0;
      const edge = Math.max(0, Math.round(bar.getBoundingClientRect().bottom));
      if (edge === line) return;
      line = edge;
      observer?.disconnect();
      // Without a heading the observer watches the bar, and its first report says the name is not in view.
      observer = new IntersectionObserver(([entry]) => setInView(!!heading && !!entry && entry.boundingClientRect.bottom > edge), {
        rootMargin: `-${edge}px 0px 0px 0px`,
      });
      observer.observe(heading ?? bar);
    };
    const soon = () => {
      if (frame === 0) frame = requestAnimationFrame(watch);
    };
    watch();
    window.addEventListener('scroll', soon, { passive: true });
    window.addEventListener('resize', soon);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', soon);
      window.removeEventListener('resize', soon);
      observer?.disconnect();
    };
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
