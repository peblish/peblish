import { inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { actorBlockedBy } from '../blocks/predicate.ts';
import { communityBlocks, instanceBlocks } from '../blocks/tables.ts';
import type { Uuid } from '@peblish/schema/ids';
import { actors } from '../db/tables/actors.ts';
import { notifications } from './tables.ts';

// Blocks and the inbox (lane E1's tables and predicate). A reply or mention from someone the
// recipient blocked is never written, listed or counted. Removal and ban notices are never
// blocked: the statement of reasons is owed.

/**
 * SQL true when `viewerId` blocks the person `actorId` (directly or through their instance),
 * or the community `communityId` (directly or through its instance). Pass SQL for the values:
 * a parameter with a ::uuid cast, or a column written out in full. A Drizzle column would
 * lose its table name inside a single-table select and, in these sub-selects, compare a block
 * row's own column with itself.
 */
export function noticeBlocked(viewerId: Uuid, { actorId, communityId }: { actorId: SQLWrapper; communityId: SQLWrapper }): SQL<boolean> {
  return sql<boolean>`(
    ${actorBlockedBy(viewerId, actorId)}
    or exists (select 1 from ${communityBlocks} as cb where cb.blocker_id = ${viewerId} and cb.community_id = ${communityId})
    or exists (
      select 1 from ${instanceBlocks} as ib join ${actors} as community_actor on community_actor.instance_id = ib.instance_id
      where ib.blocker_id = ${viewerId} and community_actor.id = ${communityId}
    )
  )`;
}

const column = (name: string) => sql.raw(`"notifications"."${name}"`);

/**
 * The condition a query over `notifications` adds for `viewerId`'s own inbox, so a blocked
 * author's reply or mention neither lists nor counts. The columns are spelled out for the
 * reason noticeBlocked gives; the table is the one the query selects from.
 */
export const notBlocked = (viewerId: Uuid): SQL =>
  sql`not (${inArray(notifications.kind, ['reply', 'mention'])} and ${noticeBlocked(viewerId, { actorId: column('actor_id'), communityId: column('community_id') })})`;
