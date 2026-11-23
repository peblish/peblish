import { inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { actorBlockedBy } from '../blocks/predicate.ts';
import { communityBlocks, instanceBlocks, personBlocks } from '../blocks/tables.ts';
import type { Uuid } from '@peblish/schema/ids';
import { actors } from '../db/tables/actors.ts';
import { peerControls } from '../peers/tables.ts';
import { notifications } from './tables.ts';
import type { NotificationKind } from './view.ts';

// Blocks and the inbox (lane E1's tables and predicate). A reply, mention or followed thread's
// comment from someone the recipient blocked, or in a community they blocked, is never written,
// listed or counted, nor is a blocked community's acceptance of a follow. Removal and ban notices
// are never blocked: the statement of reasons is owed.

/**
 * SQL true when `viewerId` blocks the person `actorId` (directly or through their instance),
 * or the community `communityId` (directly or through its instance). Pass SQL for the values:
 * a parameter with a ::uuid cast, or a column written out in full. A Drizzle column would
 * lose its table name inside a single-table select and, in these sub-selects, compare a block
 * row's own column with itself. The viewer can be such SQL too (the thread follows' fan-out).
 */
export function noticeBlocked(
  viewerId: Uuid | SQLWrapper,
  { actorId, communityId }: { actorId: SQLWrapper; communityId: SQLWrapper },
): SQL<boolean> {
  return sql<boolean>`(
    ${actorBlockedBy(viewerId, actorId)}
    or exists (select 1 from ${communityBlocks} as cb where cb.blocker_id = ${viewerId} and cb.community_id = ${communityId})
    or exists (
      select 1 from ${instanceBlocks} as ib join ${actors} as community_actor on community_actor.instance_id = ib.instance_id
      where ib.blocker_id = ${viewerId} and community_actor.id = ${communityId}
    )
  )`;
}

/**
 * SQL true when the instance `instanceId` names (SQL written out in full, as for noticeBlocked) is
 * a peer this server blocks: the server-level block the feeds apply to a post's server and its
 * community's (peers/feed-predicate.ts), with the blocked set read once per query into an array
 * as they read it. The writers test a followed thread's commenter's, post's and community's
 * servers with it, and a follow's community's, once per event; the inbox, once per notice, reads
 * peerBlockedByKey.
 */
export const peerBlocked = (instanceId: SQLWrapper): SQL<boolean> =>
  sql<boolean>`(${instanceId} = any(array(select pc.instance_id from ${peerControls} as pc where pc.blocked)))`;

// The inbox's forms of these rules (notBlocked, and visible.ts). A condition the inbox applies
// runs once per notice, so each reads only the rows a notice names, by their keys: a scalar
// sub-select on a primary key, which Postgres runs per notice, never as one pass over the table
// as it may an EXISTS or an IN (an array of a whole set is such a pass). Only the viewer's own
// blocks are tested by EXISTS: a pass over them reads the viewer's rows alone, which
// blocks/limits.ts bounds. read.test.ts checks the rows every statement visits. Each is true or
// false, never NULL: Mark all read and a mention's write negate them (mutations.ts).

/** peerBlocked by key: the peer's own peer_controls row, false when it has none. */
export const peerBlockedByKey = (instanceId: SQLWrapper): SQL<boolean> =>
  sql<boolean>`coalesce((select pc.blocked from ${peerControls} as pc where pc.instance_id = ${instanceId}), false)`;

/** SQL true when `viewerId` blocks the instance `instanceId` names. */
export const instanceBlockedBy = (viewerId: Uuid, instanceId: SQLWrapper): SQL<boolean> =>
  sql<boolean>`exists (select 1 from ${instanceBlocks} as ib where ib.blocker_id = ${viewerId} and ib.instance_id = ${instanceId})`;

/** SQL true when `viewerId` blocks the server of the actor `actorId` names: that actor's row by key, false when there is none. */
const serverBlockedBy = (viewerId: Uuid, actorId: SQLWrapper): SQL<boolean> =>
  sql<boolean>`coalesce((
    select ${instanceBlockedBy(viewerId, sql`blocked_server.instance_id`)} from ${actors} as blocked_server where blocked_server.id = ${actorId}
  ), false)`;

/** The notices a block hides: what someone wrote, and a community's answer to a follow request. */
const blockableKinds = ['reply', 'mention', 'thread_reply', 'follow_accept'] as const satisfies readonly NotificationKind[];

const column = (name: string) => sql.raw(`"notifications"."${name}"`);

/**
 * The condition a query over `notifications` adds for `viewerId`'s own inbox, so a blocked
 * author's reply or mention neither lists nor counts: noticeBlocked's rule, read by the notice's
 * keys. The columns are spelled out for the reason noticeBlocked gives; the table is the one the
 * query selects from.
 */
export const notBlocked = (viewerId: Uuid): SQL => {
  const actorId = column('actor_id');
  const communityId = column('community_id');
  return sql`not (${inArray(notifications.kind, [...blockableKinds])} and (
    exists (select 1 from ${personBlocks} as pb where pb.blocker_id = ${viewerId} and pb.blocked_id = ${actorId})
    or exists (select 1 from ${communityBlocks} as cb where cb.blocker_id = ${viewerId} and cb.community_id = ${communityId})
    or ${serverBlockedBy(viewerId, actorId)}
    or ${serverBlockedBy(viewerId, communityId)}
  ))`;
};
