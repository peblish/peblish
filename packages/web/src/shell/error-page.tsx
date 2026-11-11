import { Button } from '@peblish/ui/components/button';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { Link } from '@peblish/ui/components/link';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { rootRouteId, useMatch, useRouter } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { DEFAULT_LOCALE } from '../i18n/negotiate.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import { useRouteHydrated } from './hydration.ts';

/**
 * The shell's strings in the request locale. Unlike useTranslate this never throws: when the
 * root loader itself failed there is no locale, and the error page speaks English.
 */
function useShellText() {
  const locale = useMatch({ from: rootRouteId, shouldThrow: false, select: (match) => match.loaderData?.locale }) ?? DEFAULT_LOCALE;
  return (key: MessageKey<'shell'>) => translate(locale, 'shell', key);
}

/** A page that says what went wrong, with a way on: the not-found and error pages, as the shared empty state. */
function Problem({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  useRouteHydrated();
  return (
    <main className="pb-page">
      <EmptyState level={1} title={title} action={children}>
        {body}
      </EmptyState>
    </main>
  );
}

/** Any address no route answers, inside the shell. */
export function PageNotFound() {
  const t = useShellText();
  return (
    <Problem title={t('notFound.title')} body={t('notFound.body')}>
      <Link href="/">{t('notFound.home')}</Link>
    </Problem>
  );
}

/**
 * A page whose loader or component failed: try again, or go home. The router renders it for
 * every route (`defaultErrorComponent`, router.tsx), on the server and in the browser alike, so
 * the server's error page hydrates as itself. A page's error leaves the shell around it; a
 * failure of the root loader renders it alone, in English. It never shows the error itself.
 *
 * Try again reruns the failed loaders once (router.invalidate on the matches in error; the
 * shell's data stays); the boundary then resets by itself, on success or with the new error. It
 * needs scripts, so it is disabled until hydration.
 */
export function PageError() {
  const t = useShellText();
  const router = useRouter();
  const hydrated = useHydrated();
  const [trying, setTrying] = useState(false);
  const retry = async () => {
    setTrying(true);
    try {
      await router.invalidate({ filter: (match) => match.status === 'error' });
    } finally {
      setTrying(false);
    }
  };
  return (
    <Problem title={t('error.title')} body={t('error.body')}>
      <Button variant="neutral" size="sm" disabled={!hydrated || trying} onActivate={() => void retry()}>
        {t('error.retry')}
      </Button>
      <Link href="/">{t('notFound.home')}</Link>
    </Problem>
  );
}
