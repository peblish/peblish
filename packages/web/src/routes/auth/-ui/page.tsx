import { Card } from '@peblish/ui/components/card';
import { notFound } from '@tanstack/react-router';
import { type } from 'arktype';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import authCss from './auth.css?url';

/** The stylesheet every lane A page links (route head). */
export const authHead = () => ({ links: [{ rel: 'stylesheet', href: authCss }] });

/**
 * A search value as a string: TanStack Router parses ?a=1 into a number, so values that can
 * look numeric (tokens, flags) are taken either way.
 */
export const SearchText = type('string | number').pipe((value) => String(value));

/** A plain column (narrow, or `wide` for tables): settings, admin and other pages that are not one task. */
export function AuthPage({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <main className={wide ? 'auth-page wide' : 'auth-page'}>{children}</main>;
}

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

/**
 * A route group's beforeLoad (routes/{auth,invite,settings,admin}/route.tsx): the group's own
 * path has no page, so /settings answers 404 like any unknown path, not an empty layout.
 */
export const noGroupPage =
  (group: string) =>
  ({ location }: { location: { pathname: string } }) => {
    if (location.pathname.replace(/\/+$/, '') === group) throw notFound();
  };
