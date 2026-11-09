import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { authUser } from '../db/tables/auth.ts';
import { instances } from '../db/tables/instances.ts';
import { writer } from '../db/write.ts';
import { readModlog } from '../modlog/read.ts';
import { truncateAll } from '../testing/db.ts';
import { admin, grantFor, outboxEvents, seedAdmin, writeCounts } from '../testing/seed-az.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { Refused } from '../tx/refused.ts';
import { peerControls } from './tables.ts';
import { updatePeer } from './update.ts';

beforeEach(truncateAll);

async function setup() {
  const instance = await seedInstance('feddit.test');
  const andrew = await seedAdmin(instance, 'Andrew');
  const member = await seedActor(instance, 'Person', 'member');
  return { instance, andrew, member, asAdmin: admin(andrew.id) };
}

const controls = async (domain: string) =>
  (
    await db()
      .select()
      .from(peerControls)
      .innerJoin(instances, eq(instances.id, peerControls.instanceId))
      .where(eq(instances.domain, domain))
  )[0];

test('peer.update: a two-factor admin may; everyone else gets auth.admin_required; this server and bad hosts are refused', async () => {
  const { andrew, member, asAdmin } = await setup();
  const ask = (principal: Parameters<typeof authorize>[1], domain: string) => authorize('peer.update', principal, { domain });
  expect(await ask(localUser(member.id), 'lemmy.test')).toEqual({ ok: false, reason: 'auth.admin_required' });
  expect(await ask({ kind: 'local', actorId: andrew.id, siteRole: 'user' }, 'lemmy.test')).toEqual({
    ok: false,
    reason: 'auth.admin_required',
  });
  expect(await ask({ kind: 'remote', actorId: member.id, announcedBy: null }, 'lemmy.test')).toEqual({
    ok: false,
    reason: 'auth.admin_required',
  });
  expect(await ask(asAdmin, 'feddit.test')).toEqual({ ok: false, reason: 'peer.local_instance' });
  for (const bad of ['', 'Lemmy.test', 'https://lemmy.test', 'lemmy.test/x', 'localhost', 'a b.test'])
    expect(await ask(asAdmin, bad), bad).toEqual({ ok: false, reason: 'peer.invalid_domain' });
  expect(await ask(asAdmin, 'lemmy.test')).toMatchObject({ ok: true, grant: { authority: { kind: 'site-admin', actorId: andrew.id } } });
});

test('an unseen host is added, controls are upserted, and one non-public modlog row and one event record the change', async () => {
  const { andrew, asAdmin } = await setup();
  const approve = await updatePeer(await grantFor('peer.update', asAdmin, { domain: 'lemmy.test' }), {
    media: 'approved',
    reason: 'known good',
  });
  const row = await controls('lemmy.test');
  expect(row?.peer_controls).toMatchObject({
    media: 'approved',
    inboxPaused: false,
    blocked: false,
    reason: 'known good',
    changedBy: andrew.id,
  });
  expect(row?.instances).toMatchObject({ local: false, origin: 'https://lemmy.test' });

  const pause = await updatePeer(await grantFor('peer.update', asAdmin, { domain: 'lemmy.test' }), { inboxPaused: true });
  const purge = await updatePeer(await grantFor('peer.update', asAdmin, { domain: 'lemmy.test' }), { purge: true });
  expect((await controls('lemmy.test'))?.peer_controls).toMatchObject({ media: 'denied', inboxPaused: true });
  expect((await controls('lemmy.test'))?.peer_controls.purgedAt).toBeInstanceOf(Date);

  const log = await readModlog({}, { audience: 'staff' });
  expect(log.map((entry) => entry.id)).toEqual([purge.modlogId, pause.modlogId, approve.modlogId]);
  expect(log[2]).toMatchObject({
    action: 'peer.update',
    public: false,
    communityId: null,
    targetApId: 'https://lemmy.test',
    details: { public: false, changes: { media: { before: 'quarantined', after: 'approved' } } },
  });
  expect(await readModlog({}, { audience: 'public' })).toEqual([]);
  expect((await outboxEvents()).map((event) => event as { type: string; media: string; purged: boolean })).toMatchObject([
    { type: 'peer.updated', media: 'approved', purged: false },
    { type: 'peer.updated', media: 'approved', purged: false },
    { type: 'peer.updated', media: 'denied', purged: true },
  ]);
});

test('a change that fails its recheck writes nothing', async () => {
  const { asAdmin } = await setup();
  const grant = await grantFor('peer.update', asAdmin, { domain: 'lemmy.test' });
  await writer().update(authUser).set({ twoFactorEnabled: false });
  const before = await writeCounts();
  await expect(updatePeer(grant, { blocked: true })).rejects.toBeInstanceOf(Refused);
  expect(await writeCounts()).toEqual(before);
  expect(await controls('lemmy.test')).toBeUndefined();
});
