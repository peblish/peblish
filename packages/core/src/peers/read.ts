import type { Uuid } from '@peblish/schema/ids';
import { count, eq, sql } from 'drizzle-orm';
import { db as readDb, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { instances } from '../db/tables/instances.ts';
import { instanceHealth } from '../remote/tables.ts';
import { peerControls } from './tables.ts';

// The Peers tab's list (lane MODF): every instance we know of except this one.

export type PeerRow = {
  instanceId: Uuid;
  domain: string;
  software: string | null;
  /** People (Person actors) we hold from the instance. */
  people: number;
  lastHeardAt: string | null;
  /** Dormant: deliveries failed for the dormancy window and it sent nothing (read only here). */
  dormant: boolean;
  media: 'quarantined' | 'approved' | 'denied';
  inboxPaused: boolean;
  blocked: boolean;
  reason: string | null;
  purgedAt: string | null;
};

export async function listPeers(q: Queryable = readDb()): Promise<PeerRow[]> {
  const people = q
    .select({ instanceId: actors.instanceId, n: count().as('n') })
    .from(actors)
    .where(eq(actors.kind, 'Person'))
    .groupBy(actors.instanceId)
    .as('people');
  const rows = await q
    .select({
      instance: instances,
      control: peerControls,
      people: sql<number>`coalesce(${people.n}, 0)::int`,
      health: instanceHealth.state,
    })
    .from(instances)
    .leftJoin(peerControls, eq(peerControls.instanceId, instances.id))
    .leftJoin(people, eq(people.instanceId, instances.id))
    .leftJoin(instanceHealth, eq(instanceHealth.instanceId, instances.id))
    .where(eq(instances.local, false))
    .orderBy(sql`${instances.lastSeenAt} desc nulls last`, instances.domain);
  return rows.map(({ instance, control, people, health }) => ({
    instanceId: instance.id,
    domain: instance.domain,
    software: instance.software,
    people,
    lastHeardAt: instance.lastSeenAt?.toISOString() ?? null,
    dormant: health === 'dormant',
    media: control?.media ?? 'quarantined',
    inboxPaused: control?.inboxPaused ?? false,
    blocked: control?.blocked ?? false,
    reason: control?.reason ?? null,
    purgedAt: control?.purgedAt?.toISOString() ?? null,
  }));
}
