import { shutdown } from '@peblish/core/lifecycle';
import { runOutboxWorker } from '@peblish/core/outbox/worker';
import { consumers } from '@peblish/core/registry/consumers.gen';
import { federationConsumers } from '@peblish/federation/registry/consumers.gen';

// The worker process (PEBLISH_PROCESS=worker): runs the glob-registered core and federation
// outbox consumers until SIGTERM or SIGINT. It logs "stopped" after a clean stop and
// "crashed" (exit 1) when the loop throws.
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => controller.abort());

let crashed = false;
try {
  await runOutboxWorker({
    signal: controller.signal,
    consumers: [...consumers, ...federationConsumers],
    // Once the cursors exist and the NOTIFY listener is up (image-smoke.sh waits for this line).
    onReady: () => console.log('worker: running outbox consumers'),
  });
} catch (error) {
  crashed = true;
  console.error('worker: crashed', error);
  process.exitCode = 1;
} finally {
  await shutdown();
}
if (!crashed) console.log('worker: stopped');
