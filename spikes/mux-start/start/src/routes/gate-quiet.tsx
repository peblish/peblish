import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { I18nProvider } from 'react-aria-components';
import { GateContent } from '../gate/GateContent';

const root = getRouteApi('__root__');

/** Diagnostic: /gate without the gate's own post-mount re-render, to isolate RAC's collection rebuild. */
export const Route = createFileRoute('/gate-quiet')({ component: GateQuietPage });

function GateQuietPage() {
  const locale = root.useLoaderData();
  return (
    <I18nProvider locale={locale}>
      <GateContent locale={locale} variant="quiet" postMountRender={false} />
    </I18nProvider>
  );
}
