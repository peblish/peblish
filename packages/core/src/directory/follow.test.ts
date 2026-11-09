import { beforeEach, expect, test } from 'vitest';
import { followState } from '../follows/read.ts';
import { truncateAll } from '../testing/db.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { seedBan, seedCommunityRemoval } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { joinCommunityAs, leaveCommunityAs } from './follow.ts';

beforeEach(truncateAll);

test('joining is accepted at once for a local community and pending for a remote one; leaving ends either', async () => {
  const { instance } = await seedLocalInstance();
  const alice = await seedActor(instance, 'Person', 'alice');
  const local = await seedActor(instance, 'Group', 'news');
  const remote = await seedActor(await seedInstance('lemmy.test', false), 'Group', 'lab');
  expect(await joinCommunityAs(localUser(alice.id), local.id)).toEqual({ ok: true, state: 'accepted' });
  expect(await joinCommunityAs(localUser(alice.id), remote.id)).toEqual({ ok: true, state: 'pending' });
  expect(await followState(alice.id, remote.id)).toBe('pending');
  expect(await leaveCommunityAs(localUser(alice.id), local.id)).toEqual({ ok: true });
  expect(await leaveCommunityAs(localUser(alice.id), remote.id)).toEqual({ ok: true });
  expect(await followState(alice.id, remote.id)).toBe('none');
});

test('a refused join or leave names its reason', async () => {
  const { instance } = await seedLocalInstance();
  const alice = await seedActor(instance, 'Person', 'alice');
  const banned = await seedActor(instance, 'Group', 'banned');
  const removed = await seedActor(instance, 'Group', 'removed');
  await seedBan(banned, alice);
  await seedCommunityRemoval(removed);
  expect(await joinCommunityAs({ kind: 'anonymous' }, banned.id)).toEqual({ ok: false, reason: 'auth.required' });
  expect(await joinCommunityAs(localUser(alice.id), banned.id)).toEqual({ ok: false, reason: 'community.banned' });
  expect(await joinCommunityAs(localUser(alice.id), removed.id)).toEqual({ ok: false, reason: 'community.removed' });
  expect(await leaveCommunityAs(localUser(alice.id), banned.id)).toEqual({ ok: false, reason: 'target.not_found' });
  expect(await leaveCommunityAs({ kind: 'anonymous' }, banned.id)).toEqual({ ok: false, reason: 'auth.required' });
});
