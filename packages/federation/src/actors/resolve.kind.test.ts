import { beforeEach, expect, test, vi } from 'vitest';
import { truncateAll } from '@peblish/core/testing/db';
import { actorDocument, rsaKeys, seedLocalInstance, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { ActorResolveError, resolveRemoteActor } from './resolve.ts';

// storeRemoteActor refuses an actor whose kind changed with a RemoteActorKindError (core/remote,
// lane REM). This stands in for it, so the conversion is tested whatever the real class is called
// in the module it lives in.
class RemoteActorKindError extends Error {
  override readonly name = 'RemoteActorKindError';
}

vi.mock('@peblish/core/remote/actors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@peblish/core/remote/actors')>()),
  storeRemoteActor: vi.fn(async () => {
    throw new RemoteActorKindError('https://lemmy.test/u/x was a Person and is now a Group');
  }),
}));

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

test('a kind change the store refuses is an invalid actor, not an unexpected failure', async () => {
  const person = actorDocument('lemmy.test', 'x', { publicKeyPem: rsaKeys().publicKeyPem });
  const { fetch } = stubFetch({ [person.id]: { body: person } });
  const error = await resolveRemoteActor(person.id, { fetch }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ActorResolveError);
  expect(error).toMatchObject({ reason: 'invalid', transient: false, message: expect.stringContaining('now a Group') });
});
