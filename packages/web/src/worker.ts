import { shutdown } from '@peblish/core/lifecycle';
import { assertRunnable } from '@peblish/core/outbox/consumers';
import { assertJobsRunnable, runJobs } from '@peblish/core/outbox/jobs';
import { runOutboxWorker } from '@peblish/core/outbox/worker';
import { consumers } from '@peblish/core/registry/consumers.gen';
import { jobs } from '@peblish/core/registry/jobs.gen';
import { federationConsumers } from '@peblish/federation/registry/consumers.gen';
import { federationJobs } from '@peblish/federation/registry/jobs.gen';

// The worker process (PEBLISH_PROCESS=worker): runs the glob-registered core and federation
// outbox consumers, and beside them their jobs, until SIGTERM or SIGINT. It logs "stopped"
// after a clean stop and "crashed" (exit 1) when either loop throws or two of them share a name.
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => controller.abort());

const allConsumers = [...consumers, ...federationConsumers];
const allJobs = [...jobs, ...federationJobs];
// A crash in one loop stops the other, so shutdown() never closes the pools under a running job.
const stopOnCrash = (error: unknown): never => {
  controller.abort();
  throw error;
};

let crashed = false;
try {
  // Before either loop starts, so a name clash refuses the start with nothing written.
  assertRunnable(allConsumers);
  assertJobsRunnable(allJobs, allConsumers);
  const results = await Promise.allSettled([
    runOutboxWorker({
      signal: controller.signal,
      consumers: allConsumers,
      // Once the cursors exist and the NOTIFY listener is up (image-smoke.sh waits for this line).
      onReady: () => console.log('worker: running outbox consumers'),
    }).catch(stopOnCrash),
    runJobs({ signal: controller.signal, jobs: allJobs }).catch(stopOnCrash),
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
} catch (error) {
  crashed = true;
  console.error('worker: crashed', error);
  process.exitCode = 1;
} finally {
  await shutdown();
}
if (!crashed) console.log('worker: stopped');
