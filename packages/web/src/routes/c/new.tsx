import composerCss from '@peblish/ui/composer/composer.css?url';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { type } from 'arktype';
import { DEFAULT_LOCALE } from '../../i18n/negotiate.ts';
import { translate } from '../../i18n/translate.ts';
import { privateResponses } from '../../server/auth.ts';
import { newCommunityPath } from '../../shell/paths.ts';
import { loadNewCommunity } from './-form-load.ts';
import { postCommunityForm } from './-form-post.ts';
import { FormPage } from './-ui/form-page.tsx';
import communityCss from './-ui/community.css?url';

// /c/new: the community form for a site admin with two-factor on. Personal, so never cached.

const Search = type({ 'error?': 'string' });

export const Route = createFileRoute('/c/new')({
  validateSearch: Search,
  loader: async ({ parentMatchPromise }) => {
    const [data, root] = await Promise.all([loadNewCommunity(), parentMatchPromise]);
    if (data.status === 'signed-out') throw redirect({ to: '/auth/sign-in', search: { redirect: newCommunityPath } });
    const locale = root.loaderData?.locale ?? DEFAULT_LOCALE;
    return { data, title: `${translate(locale, 'communities', 'form.title.create')} · ${root.loaderData?.shell.siteName ?? ''}` };
  },
  head: ({ loaderData }) => ({
    meta: [...(loaderData ? [{ title: loaderData.title }] : []), { name: 'robots', content: 'noindex' }],
    links: [composerCss, communityCss].map((href) => ({ rel: 'stylesheet', href })),
  }),
  component: NewCommunity,
  server: { middleware: [privateResponses], handlers: { POST: ({ request }) => postCommunityForm(request, { creating: true }) } },
});

function NewCommunity() {
  const { data } = Route.useLoaderData();
  const { error } = Route.useSearch();
  return <FormPage data={data} error={error} />;
}
