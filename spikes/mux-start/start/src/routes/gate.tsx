import { createFileRoute, getRouteApi } from '@tanstack/react-router';
// Mux UI exposes no locale API, so this is RAC's own provider: the hoisted copy of the
// react-aria-components that @muxui/react imports (see .npmrc).
import { I18nProvider } from 'react-aria-components';
import { GateContent } from '../gate/GateContent';

const root = getRouteApi('__root__');

export const Route = createFileRoute('/gate')({ component: GatePage });

function GatePage() {
  const locale = root.useLoaderData();
  return (
    <I18nProvider locale={locale}>
      <GateContent locale={locale} variant="i18n" />
    </I18nProvider>
  );
}
