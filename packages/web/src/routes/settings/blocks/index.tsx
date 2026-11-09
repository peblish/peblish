import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { pageSession } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { authHead } from '../../auth/-ui/page.tsx';
import { SettingsLayout } from '../account/-nav.tsx';

// /settings/blocks (blocks-tabs). Owned by lane E1, which builds the page; GW3's stub keeps the
// settings nav's typed link compiling and shows the heading only.

const loadBlocks = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await pageSession();
  if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: '/settings/blocks' } });
  return { admin: session.role === 'admin' };
});

export const Route = createFileRoute('/settings/blocks/')({
  loader: () => loadBlocks(),
  head: authHead,
  component: Blocks,
});

function Blocks() {
  const { t } = useTranslate();
  const data = Route.useLoaderData();
  useRouteHydrated();
  return (
    <SettingsLayout admin={data.admin}>
      <h1>{t('settings', 'nav.blocks')}</h1>
    </SettingsLayout>
  );
}
