import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { pruneBatch, retention } from './prune.ts';

/** Runs the retention batches for both tables; returns the rows deleted from each. */
export async function pruneOld(options: { now?: Date; signal?: AbortSignal } = {}): Promise<{ inbox_raw: number; deliveries: number }> {
  const now = options.now ?? new Date();
  const principal = await systemPrincipal(db(), 'scheduled');
  const total = { inbox_raw: 0, deliveries: 0 };
  for (const table of ['inbox_raw', 'deliveries'] as const) {
    for (let batch = 0; batch < retention.maxBatches && !options.signal?.aborted; batch++) {
      const decision = await authorize('remote.prune', principal, { table });
      if (!decision.ok) throw new Error(`remote.prune refused: ${decision.reason}`);
      const { rows } = await pruneBatch(decision.grant, { now });
      total[table] += rows;
      if (rows < retention.batch) break;
    }
  }
  return total;
}
