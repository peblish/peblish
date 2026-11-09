import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { defineJob } from '../outbox/jobs.ts';
import { claimScan } from './record.ts';
import { scanClaimed, type ScanDeps } from './scan.ts';

/** Rows scanned at once: a claimed batch in waves of this many fits inside a row's lease (record.ts scanLimits). */
const concurrency = 5;

/**
 * One run of the backstop: claims pending rows the inline scan of an upload left behind (a crash
 * or a restart; the inline scan answers within seconds) and scans them. Rows whose failure may
 * pass wait out their lease and come round again, up to `scanLimits.maxAttempts`. Two workers
 * running at once take different rows (FOR UPDATE SKIP LOCKED in claimScan).
 */
export async function scanPending(deps: ScanDeps = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const decision = await authorize('media.scan_claim', await systemPrincipal(db(), 'scheduled'), { mediaId: null });
  if (!decision.ok) throw new Error(`media.scan_claim refused: ${decision.reason}`);
  const claimed = await claimScan(decision.grant, { now });
  const queue = [...claimed];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let claim = queue.shift(); claim && !deps.signal?.aborted; claim = queue.shift()) {
        try {
          await scanClaimed(claim, deps);
        } catch (error) {
          // One row's trouble (a database error) must not stop the others; its lease runs out and it is tried again.
          console.error(`mediascan: scan of ${claim.mediaId} failed`, error instanceof Error ? error.name : 'error');
        }
      }
    }),
  );
  return claimed.length;
}

// Runs every 5 s on every worker; pending rows over 30 s old are the backstop's (scanLimits.jobMinAgeMs).
export const job = defineJob({
  name: 'mediascan.scan_pending',
  everyMs: 5_000,
  run: async (signal) => {
    await scanPending({ signal });
  },
});
