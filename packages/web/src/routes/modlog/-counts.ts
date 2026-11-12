import { contentCounts, moderatedCommunities } from '@peblish/core/bans/read';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../server/auth.ts';
import { input } from '../../server/input.ts';

/**
 * How much a ban with "Also remove their content" would remove, for the open ban panel: a
 * community's moderators ask about their community, an admin about anywhere. Anyone else, and a
 * signed-out reader, gets nothing back.
 */
export const loadBanCounts = createServerFn({ method: 'GET' })
  .validator(input(type({ person: 'string.uuid', 'community?': 'string.uuid' })))
  .handler(async ({ data }) => {
    const session = await pageSession();
    if (!session) return null;
    const allowed =
      session.view.siteRole === 'admin' ||
      (data.community !== undefined &&
        (await moderatedCommunities(session.view.actorId)).some((community) => community.id === data.community));
    return allowed ? contentCounts(data.person, data.community) : null;
  });
