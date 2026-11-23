import { followedListed, type FollowedCommunity } from '@peblish/core/directory/followed';
import { maxSearchLength, type DirectoryQuery } from '@peblish/core/directory/input';
import { listCommunities } from '@peblish/core/directory/read';
import { parseLookup } from '@peblish/core/resolve/parse';
import type { ActorRef } from '@peblish/schema/views';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../server/auth.ts';
import { input } from '../../server/input.ts';

// What the header's finder asks while someone types: the community directory's own search, unchanged (its
// discoverable, removal, blocked-host and age rules apply as they do on /communities), first page only, and the
// viewer's own communities that the same rules list them (core directory/followed.ts, which also leaves out what the
// viewer blocked), whatever page they fall on. A GET that reads and writes nothing, and asks no other server: no
// search history, no count, no event.

export interface FoundCommunity {
  actor: ActorRef;
  follow: 'none' | 'pending' | 'accepted';
}

export interface FinderAnswer {
  /** The directory's first page for the text; none for a handle or an address, which is the lookup row's. */
  rows: FoundCommunity[];
  /** The viewer's own communities the server lists them now (all of them for a handle, which the finder matches). */
  followed: FollowedCommunity[];
}

export const findCommunities = createServerFn({ method: 'GET' })
  .validator(input(type({ q: `string <= ${maxSearchLength}` })))
  .handler(async ({ data }): Promise<FinderAnswer> => {
    const session = await pageSession();
    // A leading "!" is a community handle's sigil, not part of its name: "!tea" searches for tea.
    const q = data.q.trim().replace(/^!/, '');
    const viewer = session ? { actorId: session.view.actorId, declared: session.view.ageDeclaredAt !== null } : null;
    // The directory's defaults (all servers, most joined first, NSFW hidden as there).
    const query: DirectoryQuery = { scope: 'all', sort: 'subscribers', nsfw: 'hide', q, page: 1 };
    const lookup = q !== '' && parseLookup(q) !== null;
    const [rows, followed] = await Promise.all([
      lookup ? [] : listCommunities(query, viewer).then((found) => found.rows.map(({ actor, follow }) => ({ actor, follow }))),
      viewer ? followedListed(query, viewer) : [],
    ]);
    return { rows, followed };
  });
