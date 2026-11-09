import { ProseLabelsProvider } from '@peblish/ui/components/prose';
import { LocaleProvider } from '@peblish/ui/locale';
import { rootThemeAttributes, systemSchemeScript } from '@peblish/ui/theme/root';
import muxCss from '@peblish/ui/styles.css?url';
import { HeadContent, Link, Outlet, Scripts, createRootRoute, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';
import { DEFAULT_LOCALE } from '../i18n/negotiate.ts';
import { translate } from '../i18n/translate.ts';
import { openInRouter, useClientLinks } from '../shell/client-links.ts';
import { useRouteHydrated } from '../shell/hydration.ts';
import { useProseLabels } from '../shell/labels.ts';
import { PrefsProvider } from '../shell/prefs.tsx';
import { getRootData } from '../shell/root-data.ts';
import { Shell } from '../shell/shell.tsx';
import { titleForRoute } from '../shell/title.ts';
import { useViewerSync } from '../shell/viewer-sync.ts';
import appCss from '../styles.css?url';

export const Route = createRootRoute({
  // One server call gathers the negotiated locale (from Accept-Language, dehydrated so the
  // client hydrates with the same value), the display cookie, the session and the sidebar's
  // lists. They only change by a full page load, a preference change (kept in state) or a
  // router.invalidate() (also run when a tab that was hidden comes back showing a different
  // viewer than the browser's latest, shell/viewer-sync.ts), so a client-side navigation does
  // not ask again.
  loader: () => getRootData(),
  staleTime: Infinity,
  head: ({ loaderData, matches }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      // The page title convention (shell/title.ts); a route's own head title wins.
      { title: titleForRoute(loaderData?.locale ?? DEFAULT_LOCALE, matches.at(-1)?.routeId) },
    ],
    // Mux UI's stylesheet is its own file so the payload budget can measure it alone
    // (e2e/payload); the app's styles come after it and share its layer order.
    links: [
      { rel: 'stylesheet', href: muxCss, id: 'pb-mux-css' },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFound,
});

/** Mux UI's `useHref`: the URL the browser shows for an internal href, as the router's own links print it. */
function useRouterHref(href: string): string {
  return useRouter().history.createHref(href);
}

function RootComponent() {
  const { locale, prefs, session } = Route.useLoaderData();
  const router = useRouter();
  const proseLabels = useProseLabels();
  const navigate = useCallback((href: string) => openInRouter(router, href), [router]);
  useClientLinks();
  useViewerSync(session?.actorId ?? '');

  // Shell marker only; the page marker comes from route content (shell/hydration.ts).
  useEffect(() => {
    document.documentElement.dataset.shellHydrated = '1';
  }, []);

  return (
    // suppressHydrationWarning: for the 'system' scheme the inline script may already have
    // switched data-muxui-color-scheme to dark before React hydrates <html>.
    <html lang={locale} {...rootThemeAttributes(prefs.scheme)} suppressHydrationWarning>
      <head>
        {prefs.scheme === 'system' && <script dangerouslySetInnerHTML={{ __html: systemSchemeScript }} />}
        <HeadContent />
      </head>
      <body>
        <LocaleProvider locale={locale} navigate={navigate} useHref={useRouterHref}>
          <PrefsProvider initial={prefs}>
            <ProseLabelsProvider value={proseLabels}>
              <Shell>
                <Outlet />
              </Shell>
            </ProseLabelsProvider>
          </PrefsProvider>
        </LocaleProvider>
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  const { locale } = Route.useLoaderData();
  useRouteHydrated();
  return (
    <main className="pb-page">
      <h1>{translate(locale, 'shell', 'notFound.title')}</h1>
      <p>{translate(locale, 'shell', 'notFound.body')}</p>
      <p>
        <Link to="/">{translate(locale, 'shell', 'notFound.home')}</Link>
      </p>
    </main>
  );
}
