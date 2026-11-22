import { Text } from '@peblish/ui/components/text';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';

/**
 * The page's name as its h1, at the top of the centre column; the frame's view header shows it too once it
 * has scrolled under the bar. (The mock puts a plain page's name in the bar itself, but on a phone the bar
 * also holds the mark, the finder and the menu, and cuts most of these names short.)
 */
export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <Text as="h1" variant="heading" size="sm" className="pb-page-title">
      {children}
    </Text>
  );
}

/**
 * One task on its own page (sign in, sign up, two-factor, reset, verify, an invite), in the Commons
 * frame's centre column: the page's name, then the form, flat on the page (the mock's form layout,
 * `auth.css`). `state` names which of a page's outcomes is shown.
 */
export function AuthPage({ title, state, children }: { title: string; state?: string; children: ReactNode }) {
  return (
    <main className="pb-page auth-page auth-body" data-state={state}>
      <PageTitle>{title}</PageTitle>
      {children}
    </main>
  );
}

/**
 * The end of a form: its other ways out at the start ("No account? Sign up"), its submit at the end, over
 * a rule (the mock's `.a-form__actions`). On a phone the two wrap onto their own rows.
 */
export function FormActions({ aside, children }: { aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="auth-actions">
      {aside && <div className="auth-actions__aside">{aside}</div>}
      {children && <div className="auth-actions__main">{children}</div>}
    </div>
  );
}

/** Day and month, in the request's locale and in UTC, so server and client render the same text. */
export function useDate() {
  const { locale } = useTranslate();
  const format = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return (iso: string) => format.format(new Date(iso));
}
