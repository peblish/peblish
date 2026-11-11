import { closePools } from '../../packages/core/src/db/pools.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';

// A remote community whose username holds an `@` and a right-to-left override, for the directory
// spec: everything after its first `@` reads, once the override reverses it, like another server.
// `node e2e/directory/hostile-seed.ts` prints { name, host, suffix } as JSON. Escapes only: this
// file holds no control character.
try {
  const suffix = Math.random().toString(36).slice(2, 8);
  const far = await seedInstance(`real-${suffix}.test`, false);
  const community = await seedActor(far, 'Group', `hostile_${suffix}@‮elpmaxe.live`, { fetchedAt: new Date() });
  console.log(JSON.stringify({ name: community.name, host: far.domain, suffix }));
} finally {
  await closePools();
}
