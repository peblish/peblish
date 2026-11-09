import { beforeEach, expect, test } from 'vitest';
import { truncateAll } from '../testing/db.ts';
import { admin, seedAdmin } from '../testing/seed-az.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { listPeers } from './read.ts';
import { updatePeerAs } from './service.ts';

beforeEach(truncateAll);

test('every known peer is listed with its people and controls; a new peer is quarantined and this server is left out', async () => {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  await seedInstance('piefed.test', false);
  const andrew = await seedAdmin(local, 'Andrew');
  await seedActor(lemmy, 'Person', 'wasp');
  await seedActor(lemmy, 'Person', 'hornet');
  await seedActor(lemmy, 'Group', 'lab');
  expect(await updatePeerAs(admin(andrew.id), 'lemmy.test', { media: 'approved', inboxPaused: true, reason: 'Spam wave' })).toMatchObject({
    ok: true,
  });
  expect(await updatePeerAs(admin(andrew.id), 'feddit.test', { blocked: true })).toEqual({ ok: false, reason: 'peer.local_instance' });
  expect(await updatePeerAs(admin(andrew.id), 'nope', { blocked: true })).toEqual({ ok: false, reason: 'peer.invalid_domain' });
  const rows = await listPeers();
  expect(rows.map((row) => [row.domain, row.people, row.media, row.inboxPaused, row.blocked, row.reason, row.dormant])).toEqual([
    ['lemmy.test', 2, 'approved', true, false, 'Spam wave', false],
    ['piefed.test', 0, 'quarantined', false, false, null, false],
  ]);
});
