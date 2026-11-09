import { DirectorySort, NsfwMode, Scope, effectiveNsfw, maxPage } from '@peblish/core/directory/input';
import { listCommunities } from '@peblish/core/directory/read';
import { parseLookup } from '@peblish/core/resolve/parse';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../server/auth.ts';

/**
 * The directory page's data for the route loader (a server function: it runs on the server for
 * a document request and over fetch for a client-side navigation). It depends on who asks (the
 * NSFW setting, the person's own joins), so it is private: pageSession says so.
 */
export const loadDirectory = createServerFn({ method: 'GET' })
  .validator(
    type({
      scope: Scope,
      sort: DirectorySort,
      nsfw: NsfwMode,
      q: 'string <= 100',
      page: type('number.integer').atLeast(1).atMost(maxPage),
    }),
  )
  .handler(async ({ data }) => {
    const session = await pageSession();
    const viewer = session ? { actorId: session.view.actorId, declared: session.view.ageDeclaredAt !== null } : null;
    const directory = await listCommunities(data, viewer);
    return {
      ...directory,
      /** The query as it was applied: a viewer who has not declared 16+ always gets Hide. */
      query: { ...data, nsfw: effectiveNsfw(data, viewer) },
      signedIn: viewer !== null,
      /** The NSFW links are for someone who declared 16+. */
      nsfwControls: viewer?.declared === true,
      /** The search is a handle or a link: the page offers to find it instead of filtering. */
      lookup: data.q !== '' && parseLookup(data.q) !== null,
      /** The clock "refreshed 2h ago" is read against, so the browser prints what the server did. */
      now: new Date().toISOString(),
    };
  });

export type DirectoryData = Awaited<ReturnType<typeof loadDirectory>>;
