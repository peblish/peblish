import { listPages, type PageRow } from '@peblish/core/pages/read';
import { seedShippedPages } from '@peblish/core/pages/save';
import { pageSlugs, type PageLanguage, type PageSlug } from '@peblish/core/pages/slugs';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { Input } from '@peblish/ui/components/input';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Table } from '@peblish/ui/components/table';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, formSession, pageSession, principalOf, readForm, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { SearchText } from '../../auth/-ui/page.tsx';
import { accessOf } from '../settings/-access.ts';
import { StatusCell } from './-status.tsx';
import { AccessNotice, AdminTitle, adminHead } from '../settings/-ui.tsx';
import { shippedPages } from './-bundled.ts';

// /admin/pages (R2 pick admin-tabs, its Pages tab): the ten pages in English and German with
// their status, an Edit link for each language and View for the live ones. A fresh instance
// starts empty; "Add the shipped drafts" adds the legal texts that ship with the app, never
// over a page that exists. No "New page": the slugs are fixed.

const Search = type({ 'added?': SearchText, 'error?': SearchText });
const path = '/admin/pages';

const loadPages = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await pageSession();
  if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: path } });
  const access = accessOf(session);
  // Signed in but not an admin with two-factor on: the denial copy, answered as a 403 (as the report queue does).
  if (access !== 'ok') {
    setResponseStatus(403);
    return { access } as const;
  }
  const rows = await listPages();
  // The shipped texts are English: the button is for a slug that has none yet.
  const canSeed = shippedPages.some(({ slug }) =>
    rows.some((row) => row.slug === slug && row.language === 'en' && row.status === 'missing'),
  );
  return { access, rows, canSeed } as const;
});

export const Route = createFileRoute('/admin/pages/')({
  validateSearch: Search,
  loader: () => loadPages(),
  head: adminHead('pages.title'),
  component: Pages,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session, reply } = await formSession(request);
        if (!session) return reply({ redirect: `/auth/sign-in?redirect=${encodeURIComponent(path)}` });
        const form = await readForm(request);
        if (form.intent !== 'seed') return reply({ redirect: `${path}?error=page.invalid` });
        const result = await seedShippedPages(principalOf(session.view), shippedPages);
        return reply({ redirect: result.ok ? `${path}?added=${result.added}` : `${path}?error=${result.reason}` });
      },
    },
  },
});

function Pages() {
  const { t, locale } = useTranslate();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  useRouteHydrated();
  if (data.access !== 'ok') return <AccessNotice access={data.access} title={t('admin', 'pages.title')} />;
  const { rows, canSeed } = data;
  const empty = rows.every((row) => row.status === 'missing');
  const added = search.added === undefined ? null : Number(search.added);
  const seed = canSeed && (
    <form method="post" action={path}>
      <Input.Input type="hidden" name="intent" value="seed" />
      <Button type="submit" variant={empty ? 'primary' : 'neutral'}>
        {t('admin', 'pages.seed')}
      </Button>
    </form>
  );
  return (
    <main className="pb-page adm-page">
      <AdminTitle>{t('admin', 'pages.title')}</AdminTitle>
      {added !== null && Number.isInteger(added) && (
        <Notice role="status" tone="success">
          {added === 0 ? t('admin', 'pages.seeded.none') : translatePlural(locale, 'admin', 'pages.seeded', added)}
        </Notice>
      )}
      {search.error && (
        <Notice role="alert" tone="danger">
          {t('admin', 'pages.error.generic')}
        </Notice>
      )}
      {empty ? (
        <EmptyState title={t('admin', 'pages.empty')} action={seed || undefined}>
          {t('admin', 'pages.empty.hint')}
        </EmptyState>
      ) : (
        <>
          {seed}
          <PagesTable rows={rows} />
        </>
      )}
    </main>
  );
}

/** The ten pages, one row each, with each language's status and Edit link, and View for a live page. */
function PagesTable({ rows }: { rows: PageRow[] }) {
  const { t } = useTranslate();
  const view = t('admin', 'pages.view');
  return (
    <Card.Root variant="outlined" padding="sm" className="adm-table">
      <Table
        aria-label={t('admin', 'pages.title')}
        columns={[
          { id: 'page', label: t('admin', 'pages.colPage'), isRowHeader: true },
          { id: 'url', label: t('admin', 'pages.colUrl') },
          { id: 'en', label: t('admin', 'pages.colEn') },
          { id: 'de', label: t('admin', 'pages.colDe') },
          { id: 'view', label: <span className="pb-sr">{view}</span>, textValue: view },
        ]}
        rows={pageSlugs.map((slug) =>
          pageRow(
            slug,
            rows.filter((row) => row.slug === slug),
            t,
          ),
        )}
      />
    </Card.Root>
  );
}

type Translate = ReturnType<typeof useTranslate>['t'];

function pageRow(slug: PageSlug, rows: PageRow[], t: Translate) {
  const name = t('admin', `pages.slug.${slug}`);
  const live = rows.some((row) => row.status === 'published' || row.status === 'changed');
  const language = (language: PageLanguage) => {
    const row = rows.find((candidate) => candidate.language === language);
    return (
      <div className="adm-cell" data-language={language}>
        {row && <StatusCell row={row} />}
        <Link
          href={`${path}/${slug}/${language}`}
          aria-label={t('admin', 'pages.edit.label', { page: name, language: t('admin', `pages.language.${language}`) })}
        >
          {t('admin', 'pages.edit')}
        </Link>
      </div>
    );
  };
  return {
    id: slug,
    values: {
      page: (
        <Text variant="label" size="md">
          {name}
        </Text>
      ),
      url: (
        <Text variant="mono" size="sm">
          /{slug}
        </Text>
      ),
      en: language('en'),
      de: language('de'),
      view: live ? <Link href={`/${slug}`}>{t('admin', 'pages.view')}</Link> : null,
    },
  };
}
