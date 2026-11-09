import composerCss from '@peblish/ui/composer/composer.css?url';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { type } from 'arktype';
import { DEFAULT_LOCALE } from '../../../i18n/negotiate.ts';
import { translate } from '../../../i18n/translate.ts';
import { privateResponses } from '../../../server/auth.ts';
import { editCommunityPath } from '../../../shell/paths.ts';
import { loadEditCommunity } from '../-form-load.ts';
import { postCommunityForm } from '../-form-post.ts';
import { FormPage } from '../-ui/form-page.tsx';
import communityCss from '../-ui/community.css?url';

// /c/<handle>/edit: the community form for its owner, a moderator or a site admin; local
// communities only. Personal, so never cached.

const Search = type({ 'error?': 'string' });

export const Route = createFileRoute('/c/$handle/edit')({
  validateSearch: Search,
  loader: async ({ params, parentMatchPromise }) => {
    const [data, root] = await Promise.all([loadEditCommunity({ data: { handle: params.handle } }), parentMatchPromise]);
    if (data.status === 'missing') throw notFound();
    if (data.status === 'signed-out') throw redirect({ to: '/auth/sign-in', search: { redirect: editCommunityPath(params.handle) } });
    const locale = root.loaderData?.locale ?? DEFAULT_LOCALE;
    return { data, title: `${translate(locale, 'communities', 'form.title.edit')} · ${root.loaderData?.shell.siteName ?? ''}` };
  },
  head: ({ loaderData }) => ({
    meta: [...(loaderData ? [{ title: loaderData.title }] : []), { name: 'robots', content: 'noindex' }],
    links: [composerCss, communityCss].map((href) => ({ rel: 'stylesheet', href })),
  }),
  component: EditCommunity,
  server: {
    middleware: [privateResponses],
    handlers: { POST: ({ request, params }) => postCommunityForm(request, { creating: false, handle: params.handle }) },
  },
});

function EditCommunity() {
  const { data } = Route.useLoaderData();
  const { error } = Route.useSearch();
  const { handle } = Route.useParams();
  return <FormPage data={data} error={error} back={handle} />;
}
