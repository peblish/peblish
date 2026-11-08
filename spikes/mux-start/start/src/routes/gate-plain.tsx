import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { GateContent } from '../gate/GateContent';

const root = getRouteApi('__root__');

/** Control for /gate: the same content with no I18nProvider, so RAC falls back to its default locale. */
export const Route = createFileRoute('/gate-plain')({ component: GatePlainPage });

function GatePlainPage() {
  const locale = root.useLoaderData();
  return <GateContent locale={locale} variant="plain" />;
}
