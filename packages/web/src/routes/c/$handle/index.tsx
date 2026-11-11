import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { DEFAULT_LOCALE } from '../../../i18n/negotiate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { rootTitleData } from '../../../shell/title.ts';
import { directoryPaths } from '../../../shell/paths.ts';
import { parseFeedSearch, resolveFeedSearch } from '../../index/-feed/search.ts';
import feedCss from '../../index/-feed/feed.css?url';
import { loadCommunityPage } from '../-load.ts';
import { communityPost } from '../-intents.ts';
import { CommunityPage } from '../-ui/community-page.tsx';
import communityCss from '../-ui/community.css?url';
import { GateNotice } from '../-ui/gate.tsx';
import gateCss from '../-ui/gate.css?url';

// /c/<handle>: the community page, or the NSFW gate in its place. `name` is a local community,
// `name@host` a remote one (communityPath). The page is personal (the gate, the join state and
// the tools depend on who looks), so the loader's server function sets cache-control: no-store.
// POST takes the form intents of c/-intents.ts (join, leave, declare, show and hide NSFW).

const Search = (raw: Parameters<typeof parseFeedSearch>[0] & { error?: unknown }) => ({
  ...parseFeedSearch(raw),
  error: typeof raw.error === 'string' ? raw.error : undefined,
});

export const Route = createFileRoute('/c/$handle/')({
  validateSearch: Search,
  loaderDeps: ({ search }) => resolveFeedSearch(search),
  loader: async ({ params, deps }) => {
    const data = await loadCommunityPage({
      data: { handle: params.handle, sort: deps.sort, period: deps.period, ...(deps.cursor ? { cursor: deps.cursor } : {}) },
    });
    if (data.kind === 'missing') throw notFound({ data });
    return data;
  },
  head: ({ loaderData, matches }) => {
    const { site } = rootTitleData(matches.find((match) => (match.routeId as string) === '__root__')?.loaderData, DEFAULT_LOCALE);
    const robots = !loaderData || loaderData.kind !== 'page' || !loaderData.indexable ? [{ name: 'robots', content: 'noindex' }] : [];
    return {
      meta: [...(loaderData?.kind === 'page' ? [{ title: `${loaderData.title} · ${site}` }] : []), ...robots],
      links: [
        { rel: 'stylesheet', href: feedCss },
        { rel: 'stylesheet', href: communityCss },
        { rel: 'stylesheet', href: gateCss },
      ],
    };
  },
  component: CommunityRoute,
  notFoundComponent: ({ data }) => <CommunityNotFound handle={(data as { handle: string }).handle} />,
  server: { handlers: { POST: ({ request, params }) => communityPost(request, params.handle) } },
});

function CommunityRoute() {
  const data = Route.useLoaderData();
  const { error, ...feed } = Route.useSearch();
  if (data.kind === 'gate') return <GateNotice data={data} error={error} />;
  return <CommunityPage data={data} search={feed} error={error} />;
}

/** Unknown, deleted or removed. An unknown remote handle may just not be held here yet: /resolve can fetch it. */
function CommunityNotFound({ handle }: { handle: string }) {
  const { t } = useTranslate();
  useRouteHydrated();
  return (
    <main className="cm-page cm-missing" data-state="not-found">
      <Text as="h1" variant="heading" size="md">
        {t('communities', 'page.notFound.title')}
      </Text>
      <Text as="p">{t('communities', 'page.notFound.body')}</Text>
      {handle.includes('@') && (
        <Text as="p">
          <Link href={`${directoryPaths.find}?${new URLSearchParams({ q: `!${handle}` })}`}>
            {t('communities', 'page.notFound.resolve')}
          </Link>
        </Text>
      )}
    </main>
  );
}
