import { shutdown } from '@peblish/core/lifecycle';
import { runOutboxWorker } from '@peblish/core/outbox/worker';

// The worker process (image command `worker`): runs the glob-registered outbox consumers
// until SIGTERM or SIGINT. Federation delivery joins as a consumer in lane FED-A.
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => controller.abort());

console.log('worker: running outbox consumers');
try {
  await runOutboxWorker({ signal: controller.signal });
} finally {
  await shutdown();
  console.log('worker: stopped');
}
