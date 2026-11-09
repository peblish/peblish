import { listPages, readDraft, unresolvedTokens } from '@peblish/core/pages/read';
import { publishPageAs, unpublishPageAs } from '@peblish/core/pages/publish';
import { savePageAs } from '@peblish/core/pages/save';
import { isPageLanguage, isPageSlug, pageLanguages } from '@peblish/core/pages/slugs';
import { Button } from '@peblish/ui/components/button';
import { Prose } from '@peblish/ui/components/prose';
import { TextAreaField } from '@peblish/ui/components/text-area';
import { TextField } from '@peblish/ui/components/text-field';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { forbidden, formSession, pageSession, principalOf, readForm, sameOrigin } from '../../../../server/auth.ts';
import { createMarkdownRenderer } from '../../../../server/markdown.ts';
import { useRouteHydrated } from '../../../../shell/hydration.ts';
import { SearchText } from '../../../auth/-ui/page.tsx';
import { accessOf } from '../../settings/-access.ts';
import { AccessNotice, adminHead } from '../../settings/-ui.tsx';
import { StatusCell } from '../-status.tsx';

// /admin/pages/<slug>/<language>: the editor. Save draft keeps what visitors see as it is;
// Publish saves the form and then publishes it (refused while a {{TOKEN}} has no value, with
// the tokens listed); Unpublish takes the page off the site and keeps the draft. Below the form
// the saved draft is rendered as the public page renders it. An unknown slug or language is a 404.

const Search = type({ 'saved?': SearchText, 'error?': SearchText });
const Params = type({ slug: 'string', language: 'string' });
const hereOf = (slug: string, language: string) => `/admin/pages/${slug}/${language}`;

const loadEditor = createServerFn({ method: 'GET' })
  .validator(Params)
  .handler(async ({ data }) => {
    const { slug, language } = data;
    if (!isPageSlug(slug) || !isPageLanguage(language)) return null;
    const session = await pageSession();
    if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: hereOf(slug, language) } });
    const access = accessOf(session);
    if (access !== 'ok') return { access } as const;
    const [draft, rows, unresolved] = await Promise.all([readDraft(slug, language), listPages(), unresolvedTokens(slug, language)]);
    const row = rows.find((candidate) => candidate.slug === slug && candidate.language === language);
    const renderer = await createMarkdownRenderer();
    return {
      access,
      slug,
      language,
      row,
      draft: { title: draft?.title ?? '', bodyMd: draft?.bodyMd ?? '' },
      unresolved,
      previewHtml: draft ? renderer.render(draft.bodyMd).html : null,
    } as const;
  });

export const Route = createFileRoute('/admin/pages/$slug/$language')({
  validateSearch: Search,
  loader: async ({ params }) => {
    const data = await loadEditor({ data: params });
    if (!data) throw notFound();
    return data;
  },
  head: adminHead('pages.title'),
  component: Editor,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!sameOrigin(request)) return forbidden();
        const { slug, language } = params;
        if (!isPageSlug(slug) || !isPageLanguage(language)) return new Response(null, { status: 404 });
        const here = hereOf(slug, language);
        const { session, reply } = await formSession(request);
        if (!session) return reply({ redirect: `/auth/sign-in?redirect=${encodeURIComponent(here)}` });
        const form = await readForm(request);
        const principal = principalOf(session.view);
        const page = { slug, language };
        const done = (saved: string) => reply({ redirect: `${here}?saved=${saved}` });
        const failed = (reason: string) => reply({ redirect: `${here}?error=${reason}` });
        if (form.intent === 'unpublish') {
          const result = await unpublishPageAs(principal, page);
          return result.ok ? done('unpublished') : failed(result.reason);
        }
        if (form.intent !== 'save' && form.intent !== 'publish') return failed('page.invalid');
        const saved = await savePageAs(principal, page, {
          title: (form.title ?? '').trim(),
          bodyMd: (form.body ?? '').replaceAll('\r\n', '\n'),
        });
        if (!saved.ok) return failed(saved.reason);
        if (form.intent === 'save') return done('draft');
        const published = await publishPageAs(principal, page);
        return published.ok ? done('published') : failed(published.reason);
      },
    },
  },
});

const errorKeys = ['page.unresolved_tokens', 'page.invalid', 'page.not_published'] as const;

function Editor() {
  const { t } = useTranslate();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  useRouteHydrated();
  if (data.access !== 'ok') return <AccessNotice access={data.access} title={t('admin', 'pages.title')} />;
  const { slug, language, row, draft, unresolved, previewHtml } = data;
  const name = t('admin', `pages.slug.${slug}`);
  const live = row?.status === 'published' || row?.status === 'changed';
  const known = errorKeys.find((key) => key === search.error);
  const here = hereOf(slug, language);
  return (
    <main className="auth-page admin-page">
      <p>
        <a href="/admin/pages">{t('admin', 'pages.back')}</a>
        {' · '}
        {pageLanguages.map((other, index) => (
          <span key={other}>
            {index > 0 && ' · '}
            {other === language ? (
              <b>{t('admin', `pages.language.${other}`)}</b>
            ) : (
              <a href={hereOf(slug, other)}>{t('admin', `pages.language.${other}`)}</a>
            )}
          </span>
        ))}
      </p>
      <h1>{t('admin', 'pages.editor.title', { page: name, language: t('admin', `pages.language.${language}`) })}</h1>
      <p>
        <b>{t('admin', 'pages.state.label')}:</b> {row ? <StatusCell row={row} /> : null}
      </p>
      {search.saved && (
        <p className="ok-t" role="status">
          {search.saved === 'published'
            ? t('admin', 'pages.saved.published')
            : search.saved === 'unpublished'
              ? t('admin', 'pages.saved.unpublished')
              : t('admin', 'pages.saved.draft')}
        </p>
      )}
      {search.error && (
        <div className="auth-error" role="alert">
          {known === 'page.unresolved_tokens' ? (
            <>
              <p>{t('admin', 'pages.error.page.unresolved_tokens')}</p>
              <ul className="token-list">
                {unresolved.map((token) => (
                  <li key={token}>
                    <code>{token}</code>
                  </li>
                ))}
              </ul>
              <p>
                {t('admin', 'pages.error.page.unresolved_tokens.hint')}{' '}
                <a href="/admin/settings">{t('admin', 'pages.error.settingsLink')}</a>
              </p>
            </>
          ) : (
            <p>
              {known === 'page.invalid'
                ? t('admin', 'pages.error.page.invalid')
                : known === 'page.not_published'
                  ? t('admin', 'pages.error.page.not_published')
                  : t('admin', 'pages.error.generic')}
            </p>
          )}
        </div>
      )}
      <form method="post" action={here} aria-label={t('admin', 'pages.editor.formLabel')}>
        <TextField name="title" label={t('admin', 'pages.field.title')} defaultValue={draft.title} maxLength={120} required />
        <TextAreaField
          name="body"
          label={t('admin', 'pages.field.body')}
          description={t('admin', 'pages.field.body.hint')}
          defaultValue={draft.bodyMd}
          rows={24}
          maxLength={50000}
        />
        <div className="page-actions">
          <Button type="submit" name="intent" value="save" variant="neutral">
            {t('admin', 'pages.save')}
          </Button>
          <Button type="submit" name="intent" value="publish" variant="primary">
            {t('admin', 'pages.publish')}
          </Button>
          {live && (
            <Button type="submit" name="intent" value="unpublish" variant="neutral">
              {t('admin', 'pages.unpublish')}
            </Button>
          )}
        </div>
      </form>
      <section className="page-preview" aria-labelledby="preview">
        <h2 id="preview">{t('admin', 'pages.preview')}</h2>
        {previewHtml === null ? (
          <p className="muted">{t('admin', 'pages.preview.empty')}</p>
        ) : (
          <article lang={language}>
            <h1>{draft.title}</h1>
            <Prose html={previewHtml} />
          </article>
        )}
      </section>
    </main>
  );
}
