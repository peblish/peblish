import { Text } from '@peblish/ui/components/text';
import type { ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { ViewHeader } from '../../../shell/view-header.tsx';

/**
 * The page's name as its h1, in the route's own view header (Commons puts a plain page's name in the
 * bar, as the mock's Create post and Feddit's pages do). The route says `staticData: { viewHeader: 'own' }`.
 */
export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <Text as="h1" variant="label" truncate className="pb-frame-vh__title">
      {children}
    </Text>
  );
}

/**
 * One task on its own page (sign in, sign up, two-factor, reset, verify, an invite), in the Commons
 * frame's centre column: the view header with the page's name, then the form, flat on the page (the
 * mock's form layout, `auth.css`). `state` names which of a page's outcomes is shown.
 */
export function AuthPage({ title, state, children }: { title: string; state?: string; children: ReactNode }) {
  return (
    <main className="auth-page" data-state={state}>
      <ViewHeader title={<PageTitle>{title}</PageTitle>} />
      <div className="pb-page auth-body">{children}</div>
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
