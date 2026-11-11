import { Button } from '@peblish/ui/components/button';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { CatchBoundary, isNotFound, useRouterState, type ErrorComponentProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { useRouteHydrated } from './hydration.ts';

/** A page that says what went wrong, with a way on: the not-found and error pages. */
function Problem({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  useRouteHydrated();
  return (
    <main className="pb-page pb-problem">
      <Text as="h1" variant="title" size="md">
        {title}
      </Text>
      <Text as="p" color="muted">
        {body}
      </Text>
      <div className="pb-problem__actions">{children}</div>
    </main>
  );
}

/** Any address no route answers, inside the shell. */
export function PageNotFound() {
  const { t } = useTranslate();
  return (
    <Problem title={t('shell', 'notFound.title')} body={t('shell', 'notFound.body')}>
      <Link href="/">{t('shell', 'notFound.home')}</Link>
    </Problem>
  );
}

/** A page whose loader or component failed, inside the shell: try again, or go home. */
export function PageError({ reset }: ErrorComponentProps) {
  const { t } = useTranslate();
  return (
    <Problem title={t('shell', 'error.title')} body={t('shell', 'error.body')}>
      {/* The server render has no reset; the button then reloads the page. */}
      <Button variant="neutral" size="sm" onActivate={() => (reset ? reset() : window.location.reload())}>
        {t('shell', 'error.retry')}
      </Button>
      <Link href="/">{t('shell', 'notFound.home')}</Link>
    </Problem>
  );
}

/**
 * Catches a page's error below the shell, so the sidebar and the bar stay. Not-found errors go on
 * to the router's own boundary; a navigation clears the error.
 */
export function PageBoundary({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <CatchBoundary
      getResetKey={() => pathname}
      errorComponent={PageError}
      onCatch={(error) => {
        if (isNotFound(error)) throw error;
      }}
    >
      {children}
    </CatchBoundary>
  );
}
