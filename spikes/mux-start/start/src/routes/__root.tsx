import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { I18nProvider } from 'react-aria-components';
import { getRequestLocale } from '../locale';
import appCss from '../styles.css?url';

/** Diagnostic: ?i18n=root-locale or ?i18n=root-default puts RAC's I18nProvider around the root Outlet. */
type RootSearch = { i18n?: 'root-locale' | 'root-default' };

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): RootSearch =>
    search.i18n === 'root-locale' || search.i18n === 'root-default' ? { i18n: search.i18n } : {},
  // The locale comes from the document request's Accept-Language header and is
  // dehydrated with the loader data, so the client hydrates with the same value.
  loader: () => getRequestLocale(),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Mux UI on TanStack Start' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  const locale = Route.useLoaderData();
  const { i18n } = Route.useSearch();

  // Shell marker only. The route content below <Outlet /> sits in TanStack Router's
  // Suspense boundary and hydrates in a later pass, so this fires before it is interactive.
  // The page marker (data-hydrated) is set by the gate content itself.
  useEffect(() => {
    document.documentElement.dataset.shellHydrated = '1';
  }, []);

  const outlet =
    i18n === 'root-locale' ? (
      <I18nProvider locale={locale}>
        <Outlet />
      </I18nProvider>
    ) : i18n === 'root-default' ? (
      <I18nProvider>
        <Outlet />
      </I18nProvider>
    ) : (
      <Outlet />
    );

  // The Mux theme scope sits on <html>: ColorModeToggle writes data-muxui-color-scheme
  // there, and theme and mode attributes must share one scope element.
  return (
    <html lang={locale} data-muxui-theme="standard-harbour" data-muxui-color-scheme="light">
      <head>
        <HeadContent />
      </head>
      <body>
        {outlet}
        <Scripts />
      </body>
    </html>
  );
}
