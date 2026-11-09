import { beforeEach, expect, test } from 'vitest';
import { ensureLocalInstance } from '../db/bootstrap.ts';
import { localInstance } from '../db/local-instance.ts';
import { db } from '../db/read.ts';
import { authUser } from '../db/tables/auth.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor } from '../testing/seed.ts';
import { authorize } from './authorize.ts';
import { systemPrincipal } from './system.ts';

beforeEach(truncateAll);

test('site bans: admins only, never yourself, the instance actor or another admin', async () => {
  await ensureLocalInstance(writer(), 'https://feddit.test');
  const instance = { ...(await localInstance(db())), domain: 'feddit.test', local: true };
  const [adminUser, otherAdminUser] = await writer()
    .insert(authUser)
    .values([
      { name: 'Andrew', email: 'andrew@feddit.test', role: 'admin' },
      { name: 'Second', email: 'second@feddit.test', role: 'admin' },
    ])
    .returning();
  const andrew = await seedActor(instance, 'Person', 'Andrew', { userId: adminUser!.id });
  const second = await seedActor(instance, 'Person', 'second', { userId: otherAdminUser!.id });
  const spammer = await seedActor(instance, 'Person', 'spammer');
  const instanceActor = await systemPrincipal(db(), 'scheduled');
  const asAdmin = { kind: 'local', actorId: andrew.id, siteRole: 'admin' } as const;
  const ban = (principal: Parameters<typeof authorize>[1], targetActorId: string) =>
    authorize('mod.site_ban', principal, { targetActorId });

  expect(await ban({ kind: 'local', actorId: spammer.id, siteRole: 'user' }, andrew.id)).toEqual({
    ok: false,
    reason: 'auth.admin_required',
  });
  expect(await ban(asAdmin, andrew.id)).toEqual({ ok: false, reason: 'target.protected' });
  expect(await ban(asAdmin, instanceActor.actorId)).toEqual({ ok: false, reason: 'target.protected' });
  expect(await ban(asAdmin, second.id)).toEqual({ ok: false, reason: 'target.protected' });
  expect(await ban(asAdmin, spammer.id)).toMatchObject({ ok: true, grant: { authority: { kind: 'site-admin', actorId: andrew.id } } });
});
