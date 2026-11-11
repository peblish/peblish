import { closePools } from '../../packages/core/src/db/pools.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';

// A remote person whose display name carries a right-to-left override and an isolate, for the
// profile spec: `node e2e/profiles/bidi-seed.ts` prints { handle, name } as JSON. Escapes only:
// this file holds no control character.
try {
  const suffix = Math.random().toString(36).slice(2, 8);
  const far = await seedInstance(`bidi-${suffix}.lemmy.test`, false);
  const name = 'Ada \u202Eevil\u2066 Admin';
  const person = await seedActor(far, 'Person', `bidi_${suffix}`, { displayName: name });
  console.log(JSON.stringify({ handle: `${person.name}@${far.domain}`, name }));
} finally {
  await closePools();
}
