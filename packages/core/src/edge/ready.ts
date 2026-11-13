import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Queryable } from '../db/read.ts';
import { edgePurges, edgeStatus } from './tables.ts';
import { DEBT_LATE_MS, READY_FRESH_MS } from './timing.ts';

// Whether the worker's purge path works, read by web before it answers public: the worker
// proved its token within READY_FRESH_MS (a purge or the idle check that Cloudflare accepted),
// and no debt has been due for longer than DEBT_LATE_MS. No record, a stale one or old debt
// fails closed: web answers private. Times are the database's, so web and worker share one clock.

export const STATUS_ROW = 'cloudflare';

export async function purgePathReady(q: Queryable): Promise<boolean> {
  const [fresh] = await q
    .select({ name: edgeStatus.name })
    .from(edgeStatus)
    .where(and(eq(edgeStatus.name, STATUS_ROW), gt(edgeStatus.verifiedAt, sql`now() - ${`${READY_FRESH_MS} milliseconds`}::interval`)));
  if (!fresh) return false;
  const [late] = await q
    .select({ id: edgePurges.id })
    .from(edgePurges)
    .where(lt(edgePurges.dueAt, sql`now() - ${`${DEBT_LATE_MS} milliseconds`}::interval`))
    .limit(1);
  return !late;
}
