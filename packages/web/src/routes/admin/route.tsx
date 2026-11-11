import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { createFileRoute, getRouteApi, Outlet, useRouterState } from '@tanstack/react-router';
import { useTranslate } from '../../i18n/use-translate.ts';
import { privateResponses } from '../../server/auth.ts';
import { adminPaths } from '../../shell/paths.ts';
import { noGroupPage } from '../auth/-route.ts';
import adminCss from './-admin.css?url';

// Every response under /admin is personal: never from a shared cache (server/auth.ts).
//
// The layout draws the admin-tabs tab bar above each admin page: LinkTabs, real links with Mux
// Tabs' look, since each tab is its own route (Mux Tabs are buttons). It also links the admin
// stylesheet for every page under it. Admins see every tab; a moderator who is not an admin sees only Reports,
// the one admin page open to moderators. Each page still checks who may see it (signed out,
// not an admin, two-factor off), as /admin/registration does; this layout only chooses the tabs.
export const Route = createFileRoute('/admin')({
  beforeLoad: noGroupPage('/admin'),
  server: { middleware: [privateResponses] },
  head: () => ({ links: [{ rel: 'stylesheet', href: adminCss }] }),
  component: AdminLayout,
});

const root = getRouteApi('__root__');

const tabs = [
  { key: 'settings', href: adminPaths.settings },
  { key: 'pages', href: adminPaths.pages },
  { key: 'reports', href: adminPaths.reports },
  { key: 'bans', href: adminPaths.bans },
  { key: 'peers', href: adminPaths.peers },
  { key: 'media', href: adminPaths.media },
  { key: 'registration', href: adminPaths.registration },
] as const;

function AdminLayout() {
  const { t } = useTranslate();
  const { session, shell } = root.useLoaderData();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const shown = session?.siteRole === 'admin' ? tabs : shell.reportCount !== null ? tabs.filter(({ key }) => key === 'reports') : [];
  return (
    <>
      {shown.length > 0 && (
        <LinkTabs
          aria-label={t('shell', 'admin.tabs')}
          className="adm-tabs"
          items={shown.map(({ key, href }) => ({
            to: href,
            label: t('shell', `admin.tab.${key}`),
            active: pathname === href || pathname.startsWith(`${href}/`),
          }))}
        />
      )}
      <Outlet />
    </>
  );
}
