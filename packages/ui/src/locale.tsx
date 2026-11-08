import type { ReactNode } from 'react';
// Mux UI 0.1.0-rc.5 exports no locale provider; this is React Aria's own, the single hoisted
// copy @muxui/react uses (see .npmrc). Swap for Mux's export when the rc ships one.
import { I18nProvider } from 'react-aria-components';

/** Gives every Mux component the request's locale (server-detected, so SSR and hydration agree). */
export function LocaleProvider({ locale, children }: { locale: string; children: ReactNode }) {
  return <I18nProvider locale={locale}>{children}</I18nProvider>;
}
