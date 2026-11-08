import { expect, test } from 'vitest';
import { assertUniqueNames } from '../packages/core/src/outbox/consumers.ts';
import { consumers } from '../packages/core/src/registry/consumers.gen.ts';
import { federationConsumers } from '../packages/federation/src/registry/consumers.gen.ts';

// The worker runs both lists; two consumers with one name would share a cursor (it also
// refuses to start then). The generator cannot see names: they are values in each module.
test('registered consumer names are unique across core and federation', () => {
  expect(() => assertUniqueNames([...consumers, ...federationConsumers])).not.toThrow();
});
