import { MuxProvider } from '@muxui/react';
import type { ReactNode } from 'react';

/**
 * Gives every Mux component the request's locale (server-detected, so SSR and hydration agree)
 * and, optionally, the app's router: `navigate` opens a Mux Link's href without a page load and
 * `useHref` (run as a hook) turns an href into the URL the browser shows. ui imports no
 * router; the web app passes its own.
 */
export function LocaleProvider({
  locale,
  navigate,
  useHref,
  children,
}: {
  locale: string;
  navigate?: (href: string) => void;
  useHref?: (href: string) => string;
  children: ReactNode;
}) {
  return (
    <MuxProvider locale={locale} navigate={navigate} useHref={useHref}>
      {children}
    </MuxProvider>
  );
}
