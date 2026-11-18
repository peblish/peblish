import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { pruneBatch, retention, type PrunedTable } from './prune.ts';

const tables = ['inbox_raw', 'deliveries', 'inbox_dedupe', 'throttles', 'outbox'] as const;

let registered: readonly string[] = [];

/**
 * Names the outbox consumers this process runs, whose cursors bound the outbox prune. The worker
 * entry (web worker.ts) calls it before its loops start: core cannot see federation's registry.
 * Until it is called, the outbox keeps every row.
 */
export function setOutboxConsumers(names: readonly string[]): void {
  registered = [...names];
}

/**
 * Runs the retention batches for every table; returns the rows deleted from each. `consumers`
 * overrides the names setOutboxConsumers gave.
 */
export async function pruneOld(
  options: { now?: Date; signal?: AbortSignal; consumers?: readonly string[] } = {},
): Promise<Record<PrunedTable, number>> {
  const now = options.now ?? new Date();
  const consumers = options.consumers ?? registered;
  const principal = await systemPrincipal(db(), 'scheduled');
  const total = { inbox_raw: 0, deliveries: 0, inbox_dedupe: 0, throttles: 0, outbox: 0 };
  for (const table of tables) {
    for (let batch = 0; batch < retention.maxBatches && !options.signal?.aborted; batch++) {
      const decision = await authorize('remote.prune', principal, { table });
      if (!decision.ok) throw new Error(`remote.prune refused: ${decision.reason}`);
      const { rows } = await pruneBatch(decision.grant, { now, consumers });
      total[table] += rows;
      if (rows < retention.batch) break;
    }
  }
  return total;
}
