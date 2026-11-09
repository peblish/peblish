import { sql } from 'drizzle-orm';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { ageDeclarations } from '../identity/tables.ts';
import type { FeedPredicate } from '../registry/types.ts';

/**
 * C10, the NSFW gate in every feed: sensitive and NSFL posts, and every post of a sensitive or
 * NSFL community, are "never shown to logged-out or undeclared users". A signed-in viewer sees
 * them only with a 16+ declaration (age_declarations, written at sign-up), and the page then
 * puts them behind "show". The post page and postViews enforce the same rule per post
 * (posts/read.ts), so a list that forgets this predicate still withholds the content.
 *
 * The community is tested through a correlated subquery on its primary key, so posts keep the
 * index lane C1 sorts them by; the alias keeps it clear of any actors join in the feed query.
 */
export const feedPredicate: FeedPredicate = {
  name: 'nsfw-gate',
  where(viewer) {
    const clear = sql`not (${posts.sensitive} or ${posts.nsfl} or exists (
      select 1 from ${actors} as gated_community
      where gated_community.id = ${posts.communityId} and (gated_community.sensitive or gated_community.nsfl)
    ))`;
    if (!viewer) return clear;
    return sql`(${clear} or exists (select 1 from ${ageDeclarations} where ${ageDeclarations.actorId} = ${viewer.actorId}))`;
  },
};
