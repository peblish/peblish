import { maxSearchLength } from '@peblish/core/directory/input';
import { listCommunities } from '@peblish/core/directory/read';
import { parseLookup } from '@peblish/core/resolve/parse';
import type { ActorRef } from '@peblish/schema/views';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../server/auth.ts';
import { input } from '../../server/input.ts';

// What the header's finder asks while someone types: the community directory's own search, unchanged (its
// discoverable, removal, blocked-host and age rules apply as they do on /communities), first page only. A GET that
// reads and writes nothing: no search history, no count, no event.

export interface FoundCommunity {
  actor: ActorRef;
  follow: 'none' | 'pending' | 'accepted';
}

export const findCommunities = createServerFn({ method: 'GET' })
  .validator(input(type({ q: `string <= ${maxSearchLength}` })))
  .handler(async ({ data }): Promise<{ rows: FoundCommunity[] }> => {
    const session = await pageSession();
    const q = data.q.trim();
    // A handle or an address is the resolve row's: for one, the directory lists everything rather than nothing.
    if (q !== '' && parseLookup(q) !== null) return { rows: [] };
    const viewer = session ? { actorId: session.view.actorId, declared: session.view.ageDeclaredAt !== null } : null;
    // The directory's defaults (all servers, most joined first, NSFW hidden as there).
    const { rows } = await listCommunities({ scope: 'all', sort: 'subscribers', nsfw: 'hide', q, page: 1 }, viewer);
    return { rows: rows.map(({ actor, follow }) => ({ actor, follow })) };
  });
