import { createFileRoute } from '@tanstack/react-router';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { settingsHead } from '../account/-nav.tsx';
import { loadBlocks } from './-load.ts';
import { handleBlocksPost } from './-post.ts';
import { parseBlocksSearch, type BlockTab } from './-tabs.ts';
import { BlocksPage } from './-ui/blocks-page.tsx';
import blocksCss from './-ui/blocks.css?url';

// /settings/blocks (blocks-tabs): People, Communities and Instances as links with `?tab=`, so the
// page works without scripts. Lane E1's. The POST is also where every block slot posts.

export const Route = createFileRoute('/settings/blocks/')({
  validateSearch: parseBlocksSearch,
  loaderDeps: ({ search }) => ({ tab: search.tab ?? ('people' as BlockTab), just: search.just }),
  loader: ({ deps }) => loadBlocks({ data: { tab: deps.tab, ...(deps.just ? { just: deps.just } : {}) } }),
  head: () => ({ links: [...settingsHead().links, { rel: 'stylesheet', href: blocksCss }] }),
  component: Blocks,
  server: { handlers: { POST: ({ request }) => handleBlocksPost(request) } },
});

function Blocks() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  useRouteHydrated();
  return <BlocksPage data={data} search={search} />;
}
