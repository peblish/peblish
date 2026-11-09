import type { Uuid } from '@peblish/schema/ids';
import { inArray, sql } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { instanceBlocked } from '../peers/gate.ts';

/**
 * The hosts a forwarded report about this content can go to, as the outbound consumer
 * (`federation.reports`, `recipients()`) addresses them and the delivery worker's peer-block gate
 * lets them through: the community's inbox host when it is remote, then the author's when it is
 * remote and another host (shared inbox first). An actor with no inbox gets nothing, and a
 * blocked peer's inbox is skipped at send time, so neither is named. The form names these hosts;
 * `createReport` stores the ones the form named that are still here (`reports.forwarded_hosts`),
 * and only those get the Flag.
 */
export async function forwardHosts(q: Queryable, communityId: Uuid, authorId: Uuid): Promise<string[]> {
  const rows = await q
    .select({ id: actors.id, local: actors.local, inbox: sql<string | null>`coalesce(${actors.sharedInboxUrl}, ${actors.inboxUrl})` })
    .from(actors)
    .where(inArray(actors.id, [communityId, authorId]));
  const hosts: string[] = [];
  for (const id of [communityId, authorId]) {
    const actor = rows.find((row) => row.id === id);
    if (!actor || actor.local || !actor.inbox) continue;
    const host = URL.parse(actor.inbox)?.host;
    if (host && !hosts.includes(host) && !(await instanceBlocked(q, actor.inbox))) hosts.push(host);
  }
  return hosts;
}
