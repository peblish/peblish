import { beforeEach, describe, expect, test } from 'vitest';
import { truncateAll } from '../testing/db.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { outboxEvents, seedBan } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { followState } from './read.ts';
import { followAs, unfollowAs } from './service.ts';

beforeEach(truncateAll);

async function world() {
  const { instance: here } = await seedLocalInstance();
  const there = await seedInstance('lemmy.test', false);
  return {
    alice: await seedActor(here, 'Person', 'alice'),
    local: await seedActor(here, 'Group', 'news'),
    remote: await seedActor(there, 'Group', 'lab'),
  };
}

const types = async () => (await outboxEvents()).map((event) => (event as { type: string }).type);

describe('followAs and unfollowAs', () => {
  test('joining is accepted for a local community and pending for a remote one; leaving removes the follow', async () => {
    const w = await world();
    expect(await followAs(localUser(w.alice.id), w.local.id)).toEqual({ ok: true, state: 'accepted', created: true });
    expect(await followAs(localUser(w.alice.id), w.remote.id)).toEqual({ ok: true, state: 'pending', created: true });
    expect(await followAs(localUser(w.alice.id), w.remote.id)).toEqual({ ok: true, state: 'pending', created: false });
    expect(await unfollowAs(localUser(w.alice.id), w.remote.id)).toEqual({ ok: true, removed: true });
    expect(await followState(w.alice.id, w.remote.id)).toBe('none');
    expect(await types()).toEqual(['follow.accepted', 'follow.requested', 'follow.removed']);
  });

  test('refusals come back as results', async () => {
    const w = await world();
    await seedBan(w.local, w.alice);
    expect(await followAs({ kind: 'anonymous' }, w.local.id)).toEqual({ ok: false, reason: 'auth.required' });
    expect(await followAs(localUser(w.alice.id), w.local.id)).toEqual({ ok: false, reason: 'community.banned' });
    expect(await unfollowAs({ kind: 'anonymous' }, w.remote.id)).toEqual({ ok: false, reason: 'auth.required' });
    expect(await unfollowAs(localUser(w.alice.id), w.remote.id)).toEqual({ ok: false, reason: 'target.not_found' });
    expect(await types()).toEqual([]);
  });
});
