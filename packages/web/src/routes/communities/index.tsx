import { parseDirectorySearch, resolveDirectoryQuery } from '@peblish/core/directory/input';
import { createFileRoute } from '@tanstack/react-router';
import { DEFAULT_LOCALE } from '../../i18n/negotiate.ts';
import { translate } from '../../i18n/translate.ts';
import { loadDirectory } from './-load.ts';
import { DirectoryPage } from './-ui/directory-page.tsx';
import { DirectoryPending } from './-ui/directory-pending.tsx';
import directoryCss from './-ui/directory.css?url';
import { ownTitle } from '../../shell/title.ts';

// /communities: every community this server knows, local and remote, as rows or cards (List or
// Cards, the browser's choice). Plain links and one GET search form, so it works before the page
// hydrates and without script. Finding a community on another server is /resolve. A top
// destination with its own view header (its name and the view choice).

export const Route = createFileRoute('/communities/')({
  staticData: { viewHeader: 'own' },
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
  head: (context) => ({
    meta: ownTitle(context, context.loaderData?.title),
    links: [{ rel: 'stylesheet', href: directoryCss }],
  }),
  component: DirectoryRoute,
  pendingComponent: DirectoryPending,
});

function DirectoryRoute() {
  return <DirectoryPage data={Route.useLoaderData()} error={Route.useSearch({ select: (search) => search.error })} />;
}
