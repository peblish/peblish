import { MuxProvider } from '@muxui/react';
import type { ReactNode } from 'react';

/** Gives every Mux component the request's locale (server-detected, so SSR and hydration agree). */
export function LocaleProvider({ locale, children }: { locale: string; children: ReactNode }) {
  return <MuxProvider locale={locale}>{children}</MuxProvider>;
}
