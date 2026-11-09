import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@peblish/ui/components/button';
import { useState } from 'react';
import { useTranslate } from '../i18n/use-translate.ts';
import { useRouteHydrated } from '../shell/hydration.ts';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const { locale, t } = useTranslate();
  const [count, setCount] = useState(0);
  useRouteHydrated();
  return (
    <main className="shell">
      <h1>{t('shell', 'title')}</h1>
      <p>{t('shell', 'tagline')}</p>
      <p>
        {t('shell', 'sample')}: <span data-testid="locale-sample">{new Intl.NumberFormat(locale).format(1234.5)}</span>
      </p>
      <div>
        <Button onActivate={() => setCount((value) => value + 1)}>{t('shell', 'press')}</Button>
      </div>
      <p data-testid="press-count" aria-live="polite">
        {t('shell', 'pressed', { count })}
      </p>
    </main>
  );
}
