import { listPages, type PageRow } from '@peblish/core/pages/read';
import { seedShippedPages } from '@peblish/core/pages/save';
import { pageLanguages, pageSlugs, type PageSlug } from '@peblish/core/pages/slugs';
import { Button } from '@peblish/ui/components/button';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, formSession, pageSession, principalOf, readForm, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { SearchText } from '../../auth/-ui/page.tsx';
import { accessOf } from '../settings/-access.ts';
import { StatusCell } from './-status.tsx';
import { AccessNotice, adminHead } from '../settings/-ui.tsx';
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
  if (access !== 'ok') return { access } as const;
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
  return (
    <main className="auth-page admin-page">
      <h1>{t('admin', 'pages.title')}</h1>
      {added !== null && Number.isInteger(added) && (
        <p className="ok-t" role="status">
          {added === 0 ? t('admin', 'pages.seeded.none') : translatePlural(locale, 'admin', 'pages.seeded', added)}
        </p>
      )}
      {search.error && (
        <p className="auth-error" role="alert">
          {t('admin', 'pages.error.generic')}
        </p>
      )}
      {empty && (
        <section aria-labelledby="no-pages">
          <h2 id="no-pages">{t('admin', 'pages.empty')}</h2>
          <p className="hint">{t('admin', 'pages.empty.hint')}</p>
        </section>
      )}
      {canSeed && (
        <form method="post" action={path}>
          <input type="hidden" name="intent" value="seed" />
          <Button type="submit" variant={empty ? 'primary' : 'neutral'}>
            {t('admin', 'pages.seed')}
          </Button>
        </form>
      )}
      {!empty && <PagesTable rows={rows} />}
    </main>
  );
}

function PagesTable({ rows }: { rows: PageRow[] }) {
  const { t } = useTranslate();
  return (
    <table className="pages-table">
      <thead>
        <tr>
          <th>{t('admin', 'pages.colPage')}</th>
          <th>{t('admin', 'pages.colUrl')}</th>
          <th>{t('admin', 'pages.colEn')}</th>
          <th>{t('admin', 'pages.colDe')}</th>
          <th>
            <span className="sr">{t('admin', 'pages.view')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {pageSlugs.map((slug) => (
          <PageRowView key={slug} slug={slug} rows={rows.filter((row) => row.slug === slug)} />
        ))}
      </tbody>
    </table>
  );
}

function PageRowView({ slug, rows }: { slug: PageSlug; rows: PageRow[] }) {
  const { t } = useTranslate();
  const live = rows.some((row) => row.status === 'published' || row.status === 'changed');
  return (
    <tr data-testid="page-row" data-slug={slug}>
      <td data-label={t('admin', 'pages.colPage')}>
        <b>{t('admin', `pages.slug.${slug}`)}</b>
      </td>
      <td data-label={t('admin', 'pages.colUrl')} className="mono">
        /{slug}
      </td>
      {pageLanguages.map((language) => {
        const row = rows.find((candidate) => candidate.language === language);
        return (
          <td key={language} data-label={t('admin', language === 'en' ? 'pages.colEn' : 'pages.colDe')} data-language={language}>
            {row && <StatusCell row={row} />}
            <div>
              <a
                href={`${path}/${slug}/${language}`}
                aria-label={t('admin', 'pages.edit.label', {
                  page: t('admin', `pages.slug.${slug}`),
                  language: t('admin', `pages.language.${language}`),
                })}
              >
                {t('admin', 'pages.edit')}
              </a>
            </div>
          </td>
        );
      })}
      <td>{live && <a href={`/${slug}`}>{t('admin', 'pages.view')}</a>}</td>
    </tr>
  );
}
