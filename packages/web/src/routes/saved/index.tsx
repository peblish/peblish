import { createFileRoute } from '@tanstack/react-router';
import { privateResponses } from '../../server/auth.ts';
import { headTitle } from '../../shell/title.ts';
import feedCss from '../index/-feed/feed.css?url';
import { loadSaved } from './-load.ts';
import { handleSavePost } from './-post.ts';
import { SavedPage } from './-ui/saved-page.tsx';

// /saved: the viewer's saved posts (owner-only; a signed-out visitor is sent to sign in). The POST is
// where every Save and Unsave control posts (-post.ts). The page is personal: never from a shared cache.

export type SavedSearch = { cursor?: string | undefined; error?: string | undefined };

/**
 * A lenient search: anything unreadable or too long is dropped, never an error page. Both keys are
 * always returned (undefined when dropped), so the raw value the root route passes down never wins.
 */
export function parseSavedSearch(raw: Record<string, unknown>): SavedSearch {
  const text = (value: unknown, max: number) => (typeof value === 'string' && value !== '' && value.length <= max ? value : undefined);
  return { cursor: text(raw.cursor, 400), error: text(raw.error, 100) };
}

export const Route = createFileRoute('/saved/')({
  validateSearch: parseSavedSearch,
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ deps }) => loadSaved({ data: deps.cursor ? { cursor: deps.cursor } : {} }),
  head: (context) => ({ meta: headTitle(context, 'saves', 'title'), links: [{ rel: 'stylesheet', href: feedCss }] }),
  // The page draws its own view header, with its name as the h1.
  staticData: { viewHeader: 'own' },
  component: SavedRoute,
  server: { middleware: [privateResponses], handlers: { POST: ({ request }) => handleSavePost(request) } },
});

function SavedRoute() {
  const data = Route.useLoaderData();
  const { cursor, error } = Route.useSearch();
  return <SavedPage data={data} cursor={cursor} error={error} />;
}
