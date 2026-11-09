import type { Queryable } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { follows } from '@peblish/core/db/tables/follows';
import { instances } from '@peblish/core/db/tables/instances';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { announceShape, type AnnounceShape } from './software.ts';

/** Inbox URLs by Announce shape; an inbox is in exactly one list. */
export type FollowerInboxes = Record<AnnounceShape, string[]>;

const inboxOf = sql<string | null>`coalesce(${actors.sharedInboxUrl}, ${actors.inboxUrl})`;

/**
 * Where a local community's activities go: each remote follower's inbox, the shared inbox when
 * the follower's server has one (so an instance with a hundred followers is one delivery),
 * grouped by the Announce shape its software wants. Local followers are not here (they read
 * the database), and `skipOrigin` leaves out the origin that already has the activity (the
 * sender of a relayed one). An inbox that two followers' software would put in different groups
 * gets the FEP-1b12 shape.
 */
export async function followerInboxes(
  db: Queryable,
  actorId: string,
  { skipOrigin }: { skipOrigin?: string } = {},
): Promise<FollowerInboxes> {
  const rows = await db
    .select({ inbox: inboxOf, software: instances.software })
    .from(follows)
    .innerJoin(actors, eq(actors.id, follows.followerId))
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(and(eq(follows.followeeId, actorId), eq(follows.state, 'accepted'), eq(actors.local, false), isNull(actors.deletedAt)));
  const shapes = new Map<string, AnnounceShape>();
  for (const { inbox, software } of rows) {
    if (!inbox || !URL.canParse(inbox) || new URL(inbox).origin === skipOrigin) continue;
    const shape = announceShape(software);
    shapes.set(inbox, shapes.get(inbox) === 'create' ? 'create' : shape);
  }
  const inboxes: FollowerInboxes = { create: [], page: [] };
  for (const [inbox, shape] of [...shapes].sort(([a], [b]) => a.localeCompare(b))) inboxes[shape].push(inbox);
  return inboxes;
}

/**
 * Every remote server we trade follows with: the inboxes of the communities our people follow
 * and of the people following our communities. A person's profile edit goes to all of them,
 * as Lemmy's does to every instance it knows.
 */
export async function peerInboxes(db: Queryable): Promise<string[]> {
  const mine = await db
    .select({ inbox: inboxOf })
    .from(follows)
    .innerJoin(actors, eq(actors.id, follows.followeeId))
    .where(and(eq(follows.state, 'accepted'), eq(actors.local, false), isNull(actors.deletedAt)));
  const theirs = await db
    .select({ inbox: inboxOf })
    .from(follows)
    .innerJoin(actors, eq(actors.id, follows.followerId))
    .where(and(eq(follows.state, 'accepted'), eq(actors.local, false), isNull(actors.deletedAt)));
  return [
    ...new Set([...mine, ...theirs].map(({ inbox }) => inbox).filter((inbox): inbox is string => !!inbox && URL.canParse(inbox))),
  ].sort();
}
