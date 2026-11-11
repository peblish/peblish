import { Card } from '@peblish/ui/components/card';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';

/**
 * One task on its own page (sign in, sign up, two-factor, reset, verify, an invite): an outlined
 * Mux Card centred in the page, its parts stacked with Mux's group gap.
 */
export function AuthCard({ children, state }: { children: ReactNode; state?: string }) {
  return (
    <main className="auth-center" data-state={state}>
      <Card.Root variant="outlined" padding="lg" className="auth-card">
        {children}
      </Card.Root>
    </main>
  );
}

/** Day and month, in the request's locale and in UTC, so server and client render the same text. */
export function useDate() {
  const { locale } = useTranslate();
  const format = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return (iso: string) => format.format(new Date(iso));
}
