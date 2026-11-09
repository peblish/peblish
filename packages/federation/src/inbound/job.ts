import { defineJob } from '@peblish/core/outbox/jobs';
import { readSetting } from '@peblish/core/settings/read';
import { processRow } from './pipeline.ts';
import { ClaimLost, leasePending, renewLease, retryLater } from './queue.ts';

// The inbound worker: takes the rows receive.ts stored, oldest first, and runs each through
// the pipeline. It polls, so an activity is applied within a second of arriving. Every worker
// runs it; rows are claimed with SKIP LOCKED under a lease (queue.ts). While the inbox kill
// switch is off nothing is processed, so what arrived waits.

const batchSize = 20;
/** Most rows one run takes, so the worker returns to its schedule under load. */
const maxRows = 500;

export async function processPending(options: { signal?: AbortSignal; maxRows?: number } = {}): Promise<number> {
  if (!(await readSetting('inbox.enabled'))) return 0;
  let done = 0;
  while (!options.signal?.aborted && done < (options.maxRows ?? maxRows)) {
    const rows = await leasePending(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (options.signal?.aborted) break;
      try {
        // Rows behind others in the batch have waited with their lease running.
        await renewLease(row);
        await processRow(row);
      } catch (error) {
        if (error instanceof ClaimLost) {
          console.warn(`inbound: ${error.message}; the worker that holds it settles it`);
          continue;
        }
        console.error(`inbound: activity ${row.activityId ?? row.id} will be tried again`, error);
        await retryLater(row, error);
      }
      done += 1;
    }
  }
  return done;
}

export const job = defineJob({
  name: 'federation.inbound',
  everyMs: 1_000,
  run: async (signal) => {
    await processPending({ signal });
  },
});
