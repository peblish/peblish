import { eq, sql } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { outbox } from '../db/tables/outbox.ts';
import { invites } from '../db/tables/site.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance, seedTwoFactor } from '../testing/seed-a.ts';
import { findLocalPerson, loginEmail } from '../identity/handles.ts';
import { createInvite, createInviteAs, listInvites, lookupInvite, revokeInvite } from './invites.ts';
import { register } from './register.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

const admin = (actorId: string) => ({ kind: 'local', actorId, siteRole: 'admin' }) as const;

test('an admin with two-factor creates an invite for a referrer; only its hash is stored', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  await seedTwoFactor(andrew.userId);
  const mira = await seedAccount('mira');
  const decision = await authorize('invite.create', admin(andrew.actorId), { referrerId: mira.actorId });
  if (!decision.ok) throw new Error(decision.reason);
  const { id, code } = await createInvite(decision.grant, { label: 'Mira, her friends', maxUses: 3, expiresAt: null });
  expect(code).toMatch(/^PB-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  const [row] = await db().select().from(invites).where(eq(invites.id, id));
  expect(row).toMatchObject({ createdBy: mira.actorId, maxUses: 3, note: 'Mira, her friends' });
  expect(JSON.stringify(row)).not.toContain(code.replaceAll('-', ''));
  expect(await lookupInvite(code)).toEqual({
    status: 'valid',
    inviter: { name: 'mira', handle: 'mira@a.peblish.test' },
    usesLeft: 3,
    maxUses: 3,
    expiresAt: null,
  });
  const [event] = await db().select({ payload: outbox.payload }).from(outbox);
  expect(event?.payload).toMatchObject({ type: 'invite.created', inviteId: id, referrerId: mira.actorId, adminId: andrew.actorId });
});

test('invite administration needs a site admin with two-factor on', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  const mira = await seedAccount('mira');
  expect(await authorize('invite.create', admin(andrew.actorId), { referrerId: mira.actorId })).toEqual({
    ok: false,
    reason: 'admin.two_factor_required',
  });
  expect(
    await authorize('invite.create', { kind: 'local', actorId: mira.actorId, siteRole: 'user' }, { referrerId: mira.actorId }),
  ).toEqual({
    ok: false,
    reason: 'auth.admin_required',
  });
  // A session that still says admin after a demotion does not help.
  expect(await authorize('invite.create', admin(mira.actorId), { referrerId: mira.actorId })).toEqual({
    ok: false,
    reason: 'auth.admin_required',
  });
});

test('a revoked invite stops working, and the table shows who used each invite', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  await seedTwoFactor(andrew.userId);
  const created = await authorize('invite.create', admin(andrew.actorId), { referrerId: andrew.actorId });
  if (!created.ok) throw new Error(created.reason);
  const { id, code } = await createInvite(created.grant, {
    label: 'Founding group',
    maxUses: 5,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const lena = await register({ inviteCode: code, name: 'lena', email: 'lena@example.test', password: 'twelve chars ok', age: 20 });
  expect(lena.ok).toBe(true);

  const revoked = await authorize('invite.revoke', admin(andrew.actorId), { inviteId: id });
  if (!revoked.ok) throw new Error(revoked.reason);
  await revokeInvite(revoked.grant, undefined);
  expect((await lookupInvite(code)).status).toBe('revoked');
  expect(await register({ inviteCode: code, name: 'omar', email: 'omar@example.test', password: 'twelve chars ok', age: 20 })).toEqual({
    ok: false,
    reason: 'invite.revoked',
  });
  expect(await authorize('invite.revoke', admin(andrew.actorId), { inviteId: id })).toEqual({ ok: false, reason: 'invite.revoked' });

  const [row] = await listInvites();
  expect(row).toMatchObject({
    label: 'Founding group',
    referrer: { name: 'andrew', handle: 'andrew@a.peblish.test' },
    uses: 1,
    maxUses: 5,
    status: 'revoked',
    usedBy: [{ name: 'lena', handle: 'lena@a.peblish.test', emailVerified: false, deleted: false }],
  });
});

test('a local handle in any of its spellings names a person and their login', async () => {
  const andrew = await seedAccount('Andrew');
  for (const input of ['andrew', '@Andrew', '@andrew@a.peblish.test'])
    expect(await findLocalPerson(input)).toEqual({ id: andrew.actorId, name: 'Andrew' });
  expect(await findLocalPerson('@andrew@lemmy.world')).toBeNull();
  expect(await loginEmail('@andrew')).toBe('andrew@example.test');
  expect(await loginEmail('Someone@Example.test')).toBe('someone@example.test');
});

/** Backends in this database waiting on a lock. */
const waitingOnLocks = async () => {
  const [row] = await db().execute<{ waiting: number }>(
    sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return row?.waiting ?? 0;
};

test('two invites at once by one admin who refers themselves: both made, no deadlock', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  await seedTwoFactor(andrew.userId);
  // A third transaction holds the admin's row FOR SHARE, as each create's principal refresh
  // does. Had the referrer read asked for more, both creates would queue behind it holding
  // their own FOR SHARE, and its commit would leave each waiting for the other (40P01).
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const holder = writer().transaction(async (t) => {
    await t.select({ id: actors.id }).from(actors).where(eq(actors.id, andrew.actorId)).for('share');
    await released;
  });
  const input = { referrerId: andrew.actorId, label: null, maxUses: 1, expiresAt: null };
  let settled = false;
  const both = Promise.all([createInviteAs(admin(andrew.actorId), input), createInviteAs(admin(andrew.actorId), input)]).finally(
    () => (settled = true),
  );
  await expect.poll(async () => settled || (await waitingOnLocks()) >= 2).toBe(true);
  release();
  await holder;
  expect((await both).map((result) => result.ok)).toEqual([true, true]);
  expect(await db().select().from(invites)).toHaveLength(2);
});
