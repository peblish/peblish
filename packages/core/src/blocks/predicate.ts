import type { Uuid } from '@peblish/schema/ids';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { communityBlocks, instanceBlocks, personBlocks } from './tables.ts';

// The read side of blocks, for every surface that hides what a viewer blocked. Reads only: it
// takes no lock, since a block revokes nothing. `feed-predicate.ts` is the same rule over posts.

/**
 * SQL that is true when `viewerId` blocked the person `actor` names (an id column or a
 * sub-select), directly or through the instance the person lives on. For joins and filters
 * such as the inbox: `not actorBlockedBy(viewer, notifications.actorId)`.
 */
export function actorBlockedBy(viewerId: Uuid, actor: SQLWrapper): SQL {
  return sql`(
    exists (select 1 from ${personBlocks} as pb where pb.blocker_id = ${viewerId} and pb.blocked_id = ${actor})
    or exists (
      select 1 from ${instanceBlocks} as ib join ${actors} as blocked_actor on blocked_actor.instance_id = ib.instance_id
      where ib.blocker_id = ${viewerId} and blocked_actor.id = ${actor}
    )
  )`;
}

// These readers are plain SQL with an alias on every table: Drizzle drops the table name
// from a column inside a single-table select, which would make the sub-selects compare a
// column with itself.
const blockedBy = (viewerId: Uuid, actor: string) => sql`(
  (${sql.raw(actor)}.kind <> 'Group' and exists (select 1 from ${personBlocks} as pb where pb.blocker_id = ${viewerId} and pb.blocked_id = ${sql.raw(actor)}.id))
  or (${sql.raw(actor)}.kind = 'Group' and exists (select 1 from ${communityBlocks} as cb where cb.blocker_id = ${viewerId} and cb.community_id = ${sql.raw(actor)}.id))
  or exists (select 1 from ${instanceBlocks} as ib where ib.blocker_id = ${viewerId} and ib.instance_id = ${sql.raw(actor)}.instance_id)
)`;

/**
 * Which of `actorIds` the viewer blocks, in one query. A person counts when blocked directly or
 * through its instance; a Group (a community) when blocked directly or through its instance.
 */
export async function blockedAmong(q: Queryable, viewerId: Uuid, actorIds: readonly Uuid[]): Promise<Set<Uuid>> {
  if (actorIds.length === 0) return new Set();
  const rows = await q.execute<{ id: Uuid }>(
    sql`select a.id from ${actors} as a where a.id in (${sql.join(
      actorIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) and ${blockedBy(viewerId, 'a')}`,
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * How the viewer blocks one actor: 'actor' for the person or community itself, 'instance'
 * when only its instance is blocked, null when not at all. A Person (or Service) is looked up
 * in the person blocks, a Group in the community blocks.
 */
export async function blockOf(q: Queryable, viewerId: Uuid, actorId: Uuid): Promise<'actor' | 'instance' | null> {
  const rows = await q.execute<{ direct: boolean; instance: boolean }>(
    sql`select
      (a.kind <> 'Group' and exists (select 1 from ${personBlocks} as pb where pb.blocker_id = ${viewerId} and pb.blocked_id = a.id))
        or (a.kind = 'Group' and exists (select 1 from ${communityBlocks} as cb where cb.blocker_id = ${viewerId} and cb.community_id = a.id)) as direct,
      exists (select 1 from ${instanceBlocks} as ib where ib.blocker_id = ${viewerId} and ib.instance_id = a.instance_id) as instance
    from ${actors} as a where a.id = ${actorId}::uuid`,
  );
  const [row] = rows;
  if (!row) return null;
  return row.direct ? 'actor' : row.instance ? 'instance' : null;
}
