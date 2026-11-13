import { sql } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { outbox, outboxCursors } from '../db/tables/outbox.ts';
import { edgePurges, edgeStatus } from './tables.ts';
import { CONSUMER_LATE_MS, DEBT_LATE_MS, interval, READY_FRESH_MS } from './timing.ts';

// Whether the worker's purge path works, read by web inside the public decision's snapshot
// (public.ts). All of these must hold, or web answers private (fail closed):
// 1. the worker proved the token for this zone within READY_FRESH_MS (a purge or the idle check
//    that Cloudflare accepted, send.ts);
// 2. no purge has been due for longer than DEBT_LATE_MS and is still unpaid (a restore's purge
//    counts as late from the start, debt.ts);
// 3. the takedown consumer is keeping up: its cursor exists, and no outbox event older than
//    CONSUMER_LATE_MS lies beyond it (a consumer that fails, or an old open transaction holding
//    the outbox horizon back, leaves events there).
// Times are the database's, so web and worker share one clock.

export const STATUS_ROW = 'cloudflare';
/** The edge purge consumer's name (consumer.ts), which keys its outbox cursor. */
export const CONSUMER_NAME = 'edge.purge';

export async function purgePathReady(q: Queryable, zoneId: string): Promise<boolean> {
  const [row] = await q.execute<{ ready: boolean }>(sql`
    select
      exists (
        select 1 from ${edgeStatus}
        where ${edgeStatus.name} = ${STATUS_ROW} and ${edgeStatus.zoneId} = ${zoneId}
          and ${edgeStatus.verifiedAt} > now() - ${interval(READY_FRESH_MS)}::interval
      )
      and not exists (select 1 from ${edgePurges} where ${edgePurges.dueAt} < now() - ${interval(DEBT_LATE_MS)}::interval)
      and exists (
        select 1 from ${outboxCursors} c
        where c.consumer = ${CONSUMER_NAME}
          and not exists (
            select 1 from ${outbox} o
            where (o.tx_id, o.id) > (c.tx_id, c.event_id)
              and o.created_at < now() - ${interval(CONSUMER_LATE_MS)}::interval
          )
      ) as ready`);
  return row?.ready === true;
}
