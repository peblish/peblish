import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { truncateAll } from '../testing/db.ts';
import { admin, outboxEvents } from '../testing/seed-az.ts';
import { person, remote, seedPerson } from '../testing/seed-f.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { readProfile } from './read.ts';
import { updateProfileAs } from './update.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const alice = await seedPerson(local, 'alice');
  return { alice, bob: await seedPerson(local, 'bob'), remote: await seedActor(lemmy, 'Person', 'rem'), local };
}
const events = async () => (await outboxEvents()).map((event) => (event as { type: string }).type);

describe('updateProfile', () => {
  test('sets the name and bio, stores the HTML, and emits actor.updated once', async () => {
    const w = await world();
    expect(await updateProfileAs(person(w.alice.id), w.alice.id, { displayName: '  Alice A ', bio: 'I **write**' })).toEqual({
      ok: true,
      changed: true,
    });
    const profile = await readProfile('alice', null, db());
    expect(profile).toMatchObject({ actor: { displayName: 'Alice A' }, bio: { kind: 'markdown', source: 'I **write**' } });
    expect((await outboxEvents())[0]).toEqual({ type: 'actor.updated', v: 1, actorId: w.alice.id, kind: 'Person', local: true });
    expect(await updateProfileAs(person(w.alice.id), w.alice.id, { displayName: 'Alice A', bio: 'I **write**' })).toEqual({
      ok: true,
      changed: false,
    });
    expect(await events()).toEqual(['actor.updated']);
  });

  test('an absent key stays, an empty or null one clears', async () => {
    const w = await world();
    await updateProfileAs(person(w.alice.id), w.alice.id, { displayName: 'A', bio: 'text' });
    await updateProfileAs(person(w.alice.id), w.alice.id, { bio: '' });
    expect(await readProfile('alice', null)).toMatchObject({ actor: { displayName: 'A' }, bio: null });
    await updateProfileAs(person(w.alice.id), w.alice.id, { displayName: null });
    expect((await readProfile('alice', null))?.actor.displayName).toBeNull();
  });

  test('limits and refusals', async () => {
    const w = await world();
    const mine = person(w.alice.id);
    expect(await updateProfileAs(mine, w.alice.id, { displayName: 'x'.repeat(101) })).toEqual({ ok: false, reason: 'profile.invalid' });
    expect(await updateProfileAs(mine, w.alice.id, { bio: 'x'.repeat(2_001) })).toEqual({ ok: false, reason: 'profile.invalid' });
    expect(await updateProfileAs(mine, w.alice.id, { displayName: 'x'.repeat(100), bio: 'x'.repeat(2_000) })).toMatchObject({ ok: true });
    expect(await updateProfileAs({ kind: 'anonymous' }, w.alice.id, {})).toEqual({ ok: false, reason: 'auth.required' });
    expect(await updateProfileAs(person(w.bob.id), w.alice.id, { bio: 'hi' })).toEqual({ ok: false, reason: 'profile.not_own' });
    expect(await updateProfileAs(admin(w.bob.id), w.alice.id, { bio: 'hi' })).toEqual({ ok: false, reason: 'profile.not_own' });
    expect(await updateProfileAs(remote(w.remote.id), w.remote.id, { bio: 'hi' })).toEqual({ ok: false, reason: 'auth.required' });
  });
});
