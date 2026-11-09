import { expect, test } from 'vitest';
import { assertRunnable } from '../packages/core/src/outbox/consumers.ts';
import { assertJobsRunnable } from '../packages/core/src/outbox/jobs.ts';
import { consumers } from '../packages/core/src/registry/consumers.gen.ts';
import { jobs } from '../packages/core/src/registry/jobs.gen.ts';
import { federationConsumers } from '../packages/federation/src/registry/consumers.gen.ts';
import { federationJobs } from '../packages/federation/src/registry/jobs.gen.ts';

// The worker runs both lists; two consumers with one name would share a cursor (it also
// refuses to start then). The generator cannot see names: they are values in each module.
test('registered consumers are runnable together: unique names, none feeding itself', () => {
  expect(() => assertRunnable([...consumers, ...federationConsumers])).not.toThrow();
});

// The worker refuses to start when a job shares a name with another job or with a consumer.
test('registered jobs are runnable together: names unique across both lists and the consumers', () => {
  expect(() => assertJobsRunnable([...jobs, ...federationJobs], [...consumers, ...federationConsumers])).not.toThrow();
});
