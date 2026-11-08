import { shutdown } from '@peblish/core/lifecycle';
import { runOutboxWorker } from '@peblish/core/outbox/worker';
import { consumers } from '@peblish/core/registry/consumers.gen';
import { federationConsumers } from '@peblish/federation/registry/consumers.gen';

// The worker process (image command `worker`): runs the glob-registered core and federation
// outbox consumers until SIGTERM or SIGINT.
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => controller.abort());

console.log('worker: running outbox consumers');
try {
  await runOutboxWorker({ signal: controller.signal, consumers: [...consumers, ...federationConsumers] });
} finally {
  await shutdown();
  console.log('worker: stopped');
}
