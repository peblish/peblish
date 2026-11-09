import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { siteBans } from '../bans/tables.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { admin, gate, outboxEvents, someoneWaitsOnALock } from '../testing/seed-az.ts';
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
/** How many backends in this database wait on a lock. */
async function lockWaiters() {
  const [row] = await db().execute<{ n: number }>(
    sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return row?.n ?? 0;
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

  test('a site-banned person cannot edit, even when the ban lands while the edit waits for their row', async () => {
    const w = await world();
    // The ban's transaction holds alice's row as bans/site.ts does (FOR NO KEY UPDATE, then the
    // insert) and commits only once the edit waits on that row.
    const commit = gate();
    const ban = writer().transaction(async (t) => {
      await t.select({ id: actors.id }).from(actors).where(eq(actors.id, w.alice.id)).for('no key update');
      await t.insert(siteBans).values({ actorId: w.alice.id, source: 'local' });
      await commit.opened;
    });
    const edit = updateProfileAs(person(w.alice.id), w.alice.id, { bio: 'still here' });
    await expect.poll(someoneWaitsOnALock).toBe(true);
    commit.open();
    await ban;
    expect(await edit).toEqual({ ok: false, reason: 'auth.site_banned' });
    expect(await updateProfileAs(person(w.alice.id), w.alice.id, { bio: 'again' })).toEqual({ ok: false, reason: 'auth.site_banned' });
    expect((await readProfile('alice', null))?.bio).toBeNull();
    expect(await events()).toEqual([]);
  });

  test('two edits at once both apply, without a deadlock', async () => {
    const w = await world();
    // A third transaction holds alice's row FOR SHARE (as any recheck does) until both edits wait.
    // Had each edit taken FOR SHARE in its recheck before asking for more, they would deadlock.
    const release = gate();
    const holder = writer().transaction(async (t) => {
      await t.select({ id: actors.id }).from(actors).where(eq(actors.id, w.alice.id)).for('share');
      await release.opened;
    });
    const both = Promise.all([
      updateProfileAs(person(w.alice.id), w.alice.id, { displayName: 'One' }),
      updateProfileAs(person(w.alice.id), w.alice.id, { bio: 'Two' }),
    ]);
    await expect.poll(lockWaiters).toBe(2);
    release.open();
    await holder;
    expect(await both).toEqual([
      { ok: true, changed: true },
      { ok: true, changed: true },
    ]);
  });
});
