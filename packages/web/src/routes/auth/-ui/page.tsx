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

/** The narrow column the sign-in, sign-up, verify and reset pages share. */
export function AuthPage({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <main className={wide ? 'auth-page wide' : 'auth-page'}>{children}</main>;
}

/** Day and month, in the request's locale and in UTC, so server and client render the same text. */
export function useDate() {
  const { locale } = useTranslate();
  const format = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return (iso: string) => format.format(new Date(iso));
}
