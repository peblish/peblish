import { createFileRoute, Outlet } from '@tanstack/react-router';
import { privateResponses } from '../../server/auth.ts';
import { noGroupPage } from '../auth/-route.ts';
import adminCss from './-admin.css?url';

// Every response under /admin is personal: never from a shared cache (server/auth.ts).
//
// The layout links the admin stylesheet for every page under it. Each page draws its own view header
// and the admin tabs under it inside its <main> (AdminPage, -page.tsx), so the tabs sit under the
// frame's bar; each page still checks who may see it (signed out, not an admin, two-factor off).
export const Route = createFileRoute('/admin')({
  beforeLoad: noGroupPage('/admin'),
  server: { middleware: [privateResponses] },
  head: () => ({ links: [{ rel: 'stylesheet', href: adminCss }] }),
  component: AdminLayout,
});

function AdminLayout() {
  return <Outlet />;
}
