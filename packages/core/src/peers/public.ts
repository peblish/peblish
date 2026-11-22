import type { InstanceRow } from '@peblish/schema/views';
import { and, eq, sql } from 'drizzle-orm';
import { db as readDb, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { instances } from '../db/tables/instances.ts';
import { instanceHealth } from '../remote/tables.ts';
import { peerControls } from './tables.ts';

// The public Instances page (Commons, branch 5): a narrow projection of the peers, apart from the
// admins' Peers list (read.ts), which carries the controls, counts and times. It selects the two
// public fields and nothing else, so nothing more can reach the page.

/**
 * The peers this server currently federates with, by domain: remote instances that are not
 * blocked, whose inbox is not paused, that are not dormant, and that this server holds at least
 * one actor from (a row an admin named ahead, for a block, and never met is left out). Each row
 * is the domain and the software its NodeInfo names (no version), or null when unknown.
 */
export async function publicInstances(q: Queryable = readDb()): Promise<InstanceRow[]> {
  return q
    .select({ domain: instances.domain, software: instances.software })
    .from(instances)
    .leftJoin(peerControls, eq(peerControls.instanceId, instances.id))
    .leftJoin(instanceHealth, eq(instanceHealth.instanceId, instances.id))
    .where(
      and(
        eq(instances.local, false),
        sql`coalesce(${peerControls.blocked}, false) = false`,
        sql`coalesce(${peerControls.inboxPaused}, false) = false`,
        sql`coalesce(${instanceHealth.state}, 'active') <> 'dormant'`,
        sql`exists (select 1 from ${actors} where ${actors.instanceId} = ${instances.id})`,
      ),
    )
    .orderBy(instances.domain);
}

/** The Instances page's data, exactly what the route sends: the rows and nothing else. */
export async function instancesPage(q: Queryable = readDb()): Promise<{ instances: InstanceRow[] }> {
  return { instances: await publicInstances(q) };
}

/**
 * The software the NodeInfo of the peer at `domain` names (no version), for a profile's home
 * instance; null when this server does not know it or the domain is no peer.
 */
export async function peerSoftware(domain: string, q: Queryable = readDb()): Promise<string | null> {
  const [row] = await q
    .select({ software: instances.software })
    .from(instances)
    .where(and(eq(instances.domain, domain), eq(instances.local, false)));
  return row?.software ?? null;
}
