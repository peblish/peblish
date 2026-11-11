import { listPages, readDraft, unresolvedTokens } from '@peblish/core/pages/read';
import { publishPageAs, unpublishPageAs } from '@peblish/core/pages/publish';
import { savePageAs } from '@peblish/core/pages/save';
import { isPageLanguage, isPageSlug, pageLanguages } from '@peblish/core/pages/slugs';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { Breadcrumbs } from '@peblish/ui/components/breadcrumbs';
import { Button } from '@peblish/ui/components/button';
import { Input } from '@peblish/ui/components/input';
import { Link } from '@peblish/ui/components/link';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Notice } from '@peblish/ui/components/notice';
import { Prose } from '@peblish/ui/components/prose';
import { Tabs } from '@peblish/ui/components/tabs';
import { Text } from '@peblish/ui/components/text';
import { TextAreaField } from '@peblish/ui/components/text-area';
import { TextField } from '@peblish/ui/components/text-field';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseStatus } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { useRef, useState } from 'react';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { forbidden, formSession, pageSession, principalOf, readForm, sameOrigin } from '../../../../server/auth.ts';
import { createMarkdownRenderer } from '../../../../server/markdown.ts';
import { useRouteHydrated } from '../../../../shell/hydration.ts';
import { SearchText } from '../../../auth/-ui/page.tsx';
import { accessOf } from '../../settings/-access.ts';
import { AccessNotice, AdminTitle, adminHead, SectionTitle } from '../../settings/-ui.tsx';
import { StatusCell } from '../-status.tsx';

// /admin/pages/<slug>/<language>: the editor. Save draft keeps what visitors see as it is;
// Publish saves the form and then publishes it (refused while a {{TOKEN}} has no value, with
// the tokens listed); Unpublish takes the page off the site and keeps the draft. The Preview tab
// renders the typed text as the public page renders it (PageForm). An unknown slug or language is a 404.

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
    // Signed in but not an admin with two-factor on: the denial copy, answered as a 403 (as the report queue does).
    if (access !== 'ok') {
      setResponseStatus(403);
      return { access } as const;
    }
    const [draft, rows, unresolved] = await Promise.all([readDraft(slug, language), listPages(), unresolvedTokens(slug, language)]);
    const row = rows.find((candidate) => candidate.slug === slug && candidate.language === language);
    return {
      access,
      slug,
      language,
      row,
      draft: { title: draft?.title ?? '', bodyMd: draft?.bodyMd ?? '' },
      unresolved,
    } as const;
  });

/**
 * The Preview tab's rendering of the typed body, with the renderer the public page uses. Only an
 * admin may ask; a cross-site, signed-out or refused call answers null.
 */
const previewPage = createServerFn({ method: 'POST' })
  .validator(type({ body: 'string <= 50000' }))
  .handler(async ({ data }): Promise<{ html: string } | null> => {
    const session = sameOrigin(getRequest()) ? await pageSession() : null;
    if (!session || accessOf(session) !== 'ok') return null;
    return { html: (await createMarkdownRenderer()).render(data.body).html };
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
  const { slug, language, row, draft, unresolved } = data;
  const name = t('admin', `pages.slug.${slug}`);
  const title = t('admin', 'pages.editor.title', { page: name, language: t('admin', `pages.language.${language}`) });
  const live = row?.status === 'published' || row?.status === 'changed';
  const known = errorKeys.find((key) => key === search.error);
  return (
    <main className="pb-page adm-page">
      <Breadcrumbs
        aria-label={t('admin', 'pages.trail')}
        items={[{ label: t('admin', 'pages.back'), href: '/admin/pages' }, { label: title }]}
      />
      <AdminTitle>{title}</AdminTitle>
      <LinkTabs
        aria-label={t('admin', 'pages.language.label')}
        variant="segment"
        size="sm"
        items={pageLanguages.map((other) => ({
          to: hereOf(slug, other),
          label: t('admin', `pages.language.${other}`),
          active: other === language,
        }))}
      />
      <Text as="p">
        <Text variant="label" size="md">
          {t('admin', 'pages.state.label')}:
        </Text>{' '}
        {row ? <StatusCell row={row} /> : null}
      </Text>
      {search.saved && (
        <Notice role="status" tone="success">
          {search.saved === 'published'
            ? t('admin', 'pages.saved.published')
            : search.saved === 'unpublished'
              ? t('admin', 'pages.saved.unpublished')
              : t('admin', 'pages.saved.draft')}
        </Notice>
      )}
      {search.error &&
        (known === 'page.unresolved_tokens' ? (
          <Notice
            role="alert"
            tone="danger"
            title={t('admin', 'pages.error.page.unresolved_tokens')}
            action={<Link href="/admin/settings">{t('admin', 'pages.error.settingsLink')}</Link>}
          >
            <ul className="adm-tokens">
              {unresolved.map((token) => (
                <li key={token}>
                  <code>{token}</code>
                </li>
              ))}
            </ul>
            <p>{t('admin', 'pages.error.page.unresolved_tokens.hint')}</p>
          </Notice>
        ) : (
          <Notice role="alert" tone="danger">
            {known === 'page.invalid'
              ? t('admin', 'pages.error.page.invalid')
              : known === 'page.not_published'
                ? t('admin', 'pages.error.page.not_published')
                : t('admin', 'pages.error.generic')}
          </Notice>
        ))}
      {/* Keyed by page and language, so typing in one language never shows up in another. */}
      <PageForm key={`${slug}/${language}`} here={hereOf(slug, language)} language={language} draft={draft} live={live} />
    </main>
  );
}

type Preview = { status: 'idle' | 'loading' | 'failed' } | { status: 'ready'; html: string };

/**
 * The editor form: title and Markdown in the Edit tab, the actions below both tabs, each a submit
 * button naming its intent. A plain POST, so Edit and Save work before hydration and with scripts
 * off. Mux Tabs unmount the hidden panel, so the title and body live in this component's state:
 * while Preview shows, they ride in hidden inputs instead, and the form always posts each field once.
 * Preview needs scripts (its tab is disabled until hydration): it asks the server to render the
 * typed text with the renderer the public page uses.
 */
function PageForm({
  here,
  language,
  draft,
  live,
}: {
  here: string;
  language: string;
  draft: { title: string; bodyMd: string };
  live: boolean;
}) {
  const { t } = useTranslate();
  const hydrated = useHydrated();
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.bodyMd);
  const [tab, setTab] = useState('edit');
  const [preview, setPreview] = useState<Preview>({ status: 'idle' });
  const requested = useRef(0);

  async function show(next: string) {
    setTab(next);
    if (next !== 'preview') return;
    const mine = ++requested.current;
    if (body.trim() === '') return setPreview({ status: 'idle' });
    setPreview({ status: 'loading' });
    const rendered = await previewPage({ data: { body } }).catch(() => null);
    if (mine === requested.current) setPreview(rendered ? { status: 'ready', html: rendered.html } : { status: 'failed' });
  }

  return (
    <form className="adm-form adm-wide" method="post" action={here} aria-label={t('admin', 'pages.editor.formLabel')}>
      <Tabs
        aria-label={t('admin', 'pages.tabs')}
        value={tab}
        onChange={(next) => void show(next)}
        items={[
          {
            id: 'edit',
            label: t('admin', 'pages.tab.edit'),
            panel: (
              <div className="adm-section">
                <TextField
                  name="title"
                  label={t('admin', 'pages.field.title')}
                  value={title}
                  onChange={setTitle}
                  maxLength={120}
                  required
                />
                <TextAreaField
                  name="body"
                  label={t('admin', 'pages.field.body')}
                  description={t('admin', 'pages.field.body.hint')}
                  value={body}
                  onChange={setBody}
                  rows={24}
                  maxLength={50000}
                />
              </div>
            ),
          },
          {
            id: 'preview',
            label: t('admin', 'pages.tab.preview'),
            disabled: !hydrated,
            panel: (
              <section className="adm-section" aria-labelledby="preview" aria-busy={preview.status === 'loading'}>
                <SectionTitle id="preview">{t('admin', 'pages.preview')}</SectionTitle>
                {preview.status === 'ready' ? (
                  <article lang={language}>
                    <Text as="h1" variant="heading" size="md">
                      {title}
                    </Text>
                    <Prose html={preview.html} />
                  </article>
                ) : preview.status === 'failed' ? (
                  <Notice role="alert" tone="danger">
                    {t('admin', 'pages.preview.failed')}
                  </Notice>
                ) : (
                  <Text as="p" color="muted">
                    {t('admin', preview.status === 'loading' ? 'pages.preview.loading' : 'pages.preview.empty')}
                  </Text>
                )}
              </section>
            ),
          },
        ]}
      />
      {/* The Edit panel is unmounted while Preview shows: these carry its values instead. */}
      {tab === 'preview' && (
        <>
          <Input.Input type="hidden" name="title" value={title} />
          <Input.Input type="hidden" name="body" value={body} />
        </>
      )}
      <div className="adm-actions">
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
  );
}
