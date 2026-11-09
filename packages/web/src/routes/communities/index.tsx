import { parseDirectorySearch, resolveDirectoryQuery } from '@peblish/core/directory/input';
import { createFileRoute } from '@tanstack/react-router';
import { DEFAULT_LOCALE } from '../../i18n/negotiate.ts';
import { translate } from '../../i18n/translate.ts';
import { loadDirectory } from './-load.ts';
import { DirectoryPage } from './-ui/directory-page.tsx';
import directoryCss from './-ui/directory.css?url';

// /communities: every community this server knows, local and remote, as a table (directory-table).
// Plain links and one GET search form, so it works before the page hydrates and without script.
// Finding a community on another server is /resolve.

export const Route = createFileRoute('/communities/')({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...parseDirectorySearch(raw),
    // A refused join, from the form post of a browser without script.
    error: typeof raw.error === 'string' ? raw.error : undefined,
  }),
  loaderDeps: ({ search }) => resolveDirectoryQuery(search),
  loader: async ({ deps, parentMatchPromise }) => {
    const [data, root] = await Promise.all([loadDirectory({ data: deps }), parentMatchPromise]);
    const locale = root.loaderData?.locale ?? DEFAULT_LOCALE;
    return { ...data, title: `${translate(locale, 'directory', 'directory.title')} · ${root.loaderData?.shell.siteName ?? ''}` };
  },
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: loaderData.title }] : [],
    links: [{ rel: 'stylesheet', href: directoryCss }],
  }),
  component: DirectoryRoute,
});

function DirectoryRoute() {
  return <DirectoryPage data={Route.useLoaderData()} error={Route.useSearch({ select: (search) => search.error })} />;
}
