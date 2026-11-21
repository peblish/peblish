import { SectionTabs } from '@peblish/ui/components/section-tabs';
import { Text } from '@peblish/ui/components/text';
import { getRouteApi, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import { adminPaths } from '../../shell/paths.ts';
import { ViewHeader } from '../../shell/view-header.tsx';

// The staff pages in the Commons frame (the mock's page header): the page's name is the h1 in the
// frame's view header, so a route that uses PageHeader sets `staticData: ownHeader` and the shell
// leaves its default bar out. Used by the admin tabs, the report form and the modlog. The name wraps rather
// than being cut short, so a long one (a page editor's) can always be read whole.

/** The route option for a page that draws its own view header (PageHeader). */
export const ownHeader = { viewHeader: 'own' } as const;

/**
 * The frame's view header with the page's name as its h1. `root` for a top destination (the report
 * queue), which has no Back. `lang` when the name is in another language than the page around it.
 */
export function PageHeader({ title, root, lang }: { title: ReactNode; root?: boolean; lang?: string }) {
  return (
    <ViewHeader
      root={root}
      title={
        <Text as="h1" variant="label" className="pb-frame-vh__title" lang={lang}>
          {title}
        </Text>
      }
    />
  );
}

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

/**
 * The admin-tabs tab bar: SectionTabs, real links with Mux Tabs' look, since each tab is its own route
 * (Mux Tabs are buttons). Admins see every tab; a moderator who is not an admin sees only Reports, the
 * one admin page open to moderators. Each page still checks who may see it (signed out, not an admin,
 * two-factor off); this only chooses the tabs.
 */
function AdminTabs() {
  const { t } = useTranslate();
  const { session, shell } = root.useLoaderData();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const shown = session?.siteRole === 'admin' ? tabs : shell.reportCount !== null ? tabs.filter(({ key }) => key === 'reports') : [];
  if (shown.length === 0) return null;
  return (
    <SectionTabs
      aria-label={t('shell', 'admin.tabs')}
      items={shown.map(({ key, href }) => ({
        to: href,
        label: t('shell', `admin.tab.${key}`),
        active: pathname === href || pathname.startsWith(`${href}/`),
      }))}
    />
  );
}

/**
 * An admin page in the frame: its <main> holds the view header with the page's name, the admin tabs
 * under it, then the page (`pb-page`, with the page's own class for its styles). `root` on the queue.
 */
export function AdminPage({
  title,
  className,
  root: top,
  children,
}: {
  title: string;
  className: string;
  root?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="adm-main">
      <PageHeader title={title} root={top} />
      <AdminTabs />
      <div className={`pb-page ${className}`}>{children}</div>
    </main>
  );
}
