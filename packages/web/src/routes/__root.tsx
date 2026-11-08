import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';
import { LocaleProvider } from '@peblish/ui/locale';
import { rootThemeAttributes } from '@peblish/ui/theme/root';
import { useEffect } from 'react';
import { getRequestLocale } from '../i18n/locale.ts';
import { translate } from '../i18n/translate.ts';
import appCss from '../styles.css?url';

export const Route = createRootRoute({
  // The locale comes from the document request's Accept-Language header and is dehydrated
  // with the loader data, so the client hydrates with the same value.
  loader: () => getRequestLocale(),
  head: ({ loaderData }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: translate(loaderData ?? 'en-US', 'shell', 'title') },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  const locale = Route.useLoaderData();

  // Shell marker only; the page marker comes from route content (shell/hydration.ts).
  useEffect(() => {
    document.documentElement.dataset.shellHydrated = '1';
  }, []);

  return (
    <html lang={locale} {...rootThemeAttributes}>
      <head>
        <HeadContent />
      </head>
      <body>
        <LocaleProvider locale={locale}>
          <Outlet />
        </LocaleProvider>
        <Scripts />
      </body>
    </html>
  );
}
