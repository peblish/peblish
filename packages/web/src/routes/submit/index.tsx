import composerCss from '@peblish/ui/composer/composer.css?url';
import { createFileRoute, getRouteApi, redirect, useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { DEFAULT_LOCALE } from '../../i18n/negotiate.ts';
import { translate } from '../../i18n/translate.ts';
import { useTranslate } from '../../i18n/use-translate.ts';
import { clientIp, forbidden, formSession, privateResponses, principalOf, sameOrigin } from '../../server/auth.ts';
import { openInRouter } from '../../shell/client-links.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { loadComposer } from './-load.ts';
import { answer, parseSubmission, readSubmission, submit } from './-submit.ts';
import { asComposerError } from './-types.ts';
import { Composer } from './-ui/composer.tsx';
import submitCss from './-ui/submit.css?url';

// /submit: the composer as a page (composer-page), and with ?edit=<postId> the author's edit
// form. The shell's "Create post" opens the same form as a sheet over the page instead
// (shell/create-post.tsx). The form is plain: it posts here and works without JavaScript.

const root = getRouteApi('__root__');

/** A search value as a string: the router parses ?a=1 into a number. */
const Text = type('string | number').pipe((value) => String(value));
const Search = type({ 'edit?': Text, 'community?': Text, 'error?': Text, 'flash?': Text });

export const Route = createFileRoute('/submit/')({
  validateSearch: Search,
  loaderDeps: ({ search }) => ({ edit: search.edit, community: search.community, flash: search.flash }),
  loader: async ({ deps, parentMatchPromise }) => {
    const [data, root] = await Promise.all([loadComposer({ data: deps }), parentMatchPromise]);
    if (data.status === 'unavailable' && data.reason === 'signed-out') {
      // Back to the form itself after signing in; a refusal's message and words belong to the person who was refused.
      const form = new URLSearchParams();
      if (deps.edit !== undefined) form.set('edit', deps.edit);
      if (deps.community !== undefined) form.set('community', deps.community);
      throw redirect({ to: '/auth/sign-in', search: { redirect: form.size > 0 ? `/submit?${form}` : '/submit' } });
    }
    // The page title follows the shell's convention (shell/title.ts); an edit has its own name.
    const { locale } = root.loaderData ?? { locale: DEFAULT_LOCALE };
    const name = translate(locale, 'composer', deps.edit === undefined ? 'title.create' : 'title.edit');
    return { ...data, title: `${name} \u00b7 ${translate(locale, 'shell', 'title')}` };
  },
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: loaderData.title }] : [],
    links: [composerCss, submitCss].map((href) => ({ rel: 'stylesheet', href })),
  }),
  component: Submit,
  // The page is personal: never from a shared cache (server/auth.ts).
  server: {
    middleware: [privateResponses],
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session } = await formSession(request);
        const cookies = session?.setCookies ?? [];
        const read = await readSubmission(request);
        const back = {
          viewer: session?.view.actorId ?? null,
          edit: read.ok ? (read.fields.edit ?? null) : null,
          fields: read.ok ? read.fields : null,
        };
        if (!session) return answer(request, cookies, { ok: false, error: 'auth.required' }, back);
        if (!read.ok) return answer(request, cookies, read, back);
        const parsed = parseSubmission(read.fields, read.image);
        if (typeof parsed === 'string') return answer(request, cookies, { ok: false, error: parsed }, back);
        const { view } = session;
        const outcome = await submit(
          { principal: principalOf(view), viewer: { actorId: view.actorId, siteRole: view.siteRole }, ip: clientIp(request) },
          parsed,
        );
        return answer(request, cookies, outcome, back);
      },
    },
  },
});

function Submit() {
  const { t } = useTranslate();
  const router = useRouter();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  // Who the shell is showing: another tab changing the account reloads the root data (shell/viewer-sync.ts).
  const viewer = root.useLoaderData({ select: ({ session }) => session?.actorId ?? '' });
  useRouteHydrated();
  const editing = search.edit !== undefined;
  return (
    <main className="cmp-page">
      <h1>{editing ? t('composer', 'title.edit') : t('composer', 'title.create')}</h1>
      {data.status === 'unavailable' ? (
        <>
          <p role="alert">{t('composer', `unavailable.${data.reason}`)}</p>
          <p>
            <a href="/">{t('composer', 'back')}</a>
          </p>
        </>
      ) : (
        <Composer
          // Another person, a different post (or none), or the words kept from another refusal, is a different form.
          key={`${viewer}:${data.edit?.id ?? 'new'}:${search.flash ?? ''}`}
          data={data}
          error={asComposerError(search.error)}
          onDone={(path) => openInRouter(router, path)}
          onDiscard={() => openInRouter(router, '/')}
        />
      )}
    </main>
  );
}
