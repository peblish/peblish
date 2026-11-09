import { createFileRoute } from '@tanstack/react-router';
import { useTranslate } from '../i18n/use-translate.ts';
import { useRouteHydrated } from '../shell/hydration.ts';

// A placeholder: lane C1 replaces this with the home feed. The shell around it is lane UI's.
export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const { t } = useTranslate();
  useRouteHydrated();
  return (
    <main className="pb-page">
      <h1>{t('shell', 'title')}</h1>
      <p>{t('shell', 'tagline')}</p>
    </main>
  );
}
