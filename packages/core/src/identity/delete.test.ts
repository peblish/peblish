import { eq, sql } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { actorKeys, actors } from '../db/tables/actors.ts';
import { authSession, authUser } from '../db/tables/auth.ts';
import { outbox } from '../db/tables/outbox.ts';
import { deletionLedger } from '../db/tables/site.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance, seedTwoFactor } from '../testing/seed-a.ts';
import { auth } from './auth.ts';
import { deleteAccount, deleteAccountAs } from './delete.ts';
import { currentSession } from './session.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

async function signIn(email: string, password: string): Promise<Headers> {
  const { headers } = await (await auth()).api.signInEmail({ body: { email, password }, returnHeaders: true });
  const cookie = headers.getSetCookie().map((value) => value.split(';')[0]);
  return new Headers({ cookie: cookie.join('; ') });
}

test('deleting your account keeps the actor, scrubs it, signs out everywhere, and records it in one transaction', async () => {
  const mira = await seedAccount('mira');
  await writer()
    .update(actors)
    .set({ displayName: 'Mira K', summaryMd: 'hi', iconUrl: 'https://x.test/a.png' })
    .where(eq(actors.id, mira.actorId));
  const cookies = await signIn(mira.email, mira.password);
  expect((await currentSession(cookies))?.view.actorId).toBe(mira.actorId);

  const decision = await authorize('account.delete', { kind: 'local', actorId: mira.actorId, siteRole: 'user' }, { actorId: mira.actorId });
  if (!decision.ok) throw new Error(decision.reason);
  expect(decision.grant.authority).toEqual({ kind: 'owner', actorId: mira.actorId });
  await deleteAccount(decision.grant, { reason: 'owner request' });

  const [actor] = await db().select().from(actors).where(eq(actors.id, mira.actorId));
  expect(actor).toMatchObject({
    apId: 'https://a.peblish.test/ap/u.mira',
    name: 'mira',
    displayName: null,
    summaryMd: null,
    iconUrl: null,
    userId: null,
  });
  expect(actor?.deletedAt).toBeInstanceOf(Date);
  // The key stays: FED-B signs the Delete with it.
  expect(await db().select().from(actorKeys).where(eq(actorKeys.actorId, mira.actorId))).toHaveLength(1);
  expect(await db().select().from(authUser).where(eq(authUser.id, mira.userId))).toEqual([]);
  expect(await db().select().from(authSession)).toEqual([]);
  expect(await currentSession(cookies)).toBeNull();

  const [ledger] = await db().select().from(deletionLedger);
  expect(ledger).toMatchObject({ subjectKind: 'actor', subjectId: mira.actorId, subjectApId: actor?.apId, requestedBy: mira.actorId });
  expect(ledger?.details).toEqual({ userId: mira.userId, authority: 'owner' });
  const [event] = await db().select({ payload: outbox.payload }).from(outbox);
  expect(event?.payload).toEqual({ type: 'actor.deleted', v: 1, actorId: mira.actorId, kind: 'Person', local: true });
  // The event and the ledger row come from the same transaction.
  const [same] = await db().execute<{ same: boolean }>(
    sql`select (select (tx_id::text::numeric % 4294967296)::text from outbox) = (select xmin::text from deletion_ledger) as same`,
  );
  expect(same?.same).toBe(true);

  // The same grant again: the recheck finds the acting actor deleted.
  await expect(deleteAccount(decision.grant, { reason: 'again' })).rejects.toMatchObject({ reason: 'auth.actor_deleted' });
});

test("an admin may delete someone else's account, but not another admin's; nobody else may", async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  await seedTwoFactor(andrew.userId);
  const ruth = await seedAccount('ruth', { role: 'admin' });
  const mira = await seedAccount('mira');
  const lena = await seedAccount('lena');
  const asAdmin = { kind: 'local', actorId: andrew.actorId, siteRole: 'admin' } as const;
  const decision = await authorize('account.delete', asAdmin, { actorId: mira.actorId });
  expect(decision.ok && decision.grant.authority).toEqual({ kind: 'site-admin', actorId: andrew.actorId });
  expect(await authorize('account.delete', asAdmin, { actorId: ruth.actorId })).toEqual({ ok: false, reason: 'target.protected' });
  expect(await authorize('account.delete', { kind: 'local', actorId: lena.actorId, siteRole: 'user' }, { actorId: mira.actorId })).toEqual({
    ok: false,
    reason: 'auth.admin_required',
  });
});

test("a site admin's grant to delete someone does not outlive a demotion or two-factor turned off", async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  await seedTwoFactor(andrew.userId);
  const mira = await seedAccount('mira');
  const asAdmin = { kind: 'local', actorId: andrew.actorId, siteRole: 'admin' } as const;
  for (const revoke of [{ role: 'user' }, { twoFactorEnabled: false }]) {
    const decision = await authorize('account.delete', asAdmin, { actorId: mira.actorId });
    if (!decision.ok) throw new Error(decision.reason);
    await writer().update(authUser).set(revoke).where(eq(authUser.id, andrew.userId));
    await expect(deleteAccount(decision.grant, { reason: 'spam' })).rejects.toMatchObject({ reason: 'auth.admin_required' });
    await writer().update(authUser).set({ role: 'admin', twoFactorEnabled: true }).where(eq(authUser.id, andrew.userId));
  }
  const [actor] = await db().select({ deletedAt: actors.deletedAt, userId: actors.userId }).from(actors).where(eq(actors.id, mira.actorId));
  expect(actor).toEqual({ deletedAt: null, userId: mira.userId });
});

/** Backends in this database waiting on a lock. */
const waitingOnLocks = async () => {
  const [row] = await db().execute<{ waiting: number }>(
    sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return row?.waiting ?? 0;
};

test('deleting your own account twice at once: one deletes, the other is refused, no deadlock', async () => {
  const mira = await seedAccount('mira');
  const asMira = { kind: 'local', actorId: mira.actorId, siteRole: 'user' } as const;
  // A third transaction holds mira's row FOR SHARE, as a principal refresh does, until both
  // deletions wait on a lock. Had each taken FOR SHARE in its refresh and only then asked for
  // more, its commit would leave the two waiting for each other (40P01).
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const holder = writer().transaction(async (t) => {
    await t.select({ id: actors.id }).from(actors).where(eq(actors.id, mira.actorId)).for('share');
    await released;
  });
  const both = Promise.all([
    deleteAccountAs(asMira, mira.actorId, 'owner request'),
    deleteAccountAs(asMira, mira.actorId, 'owner request'),
  ]);
  await expect.poll(waitingOnLocks).toBeGreaterThanOrEqual(2);
  release();
  await holder;
  const results = await both;
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'auth.actor_deleted' }]);
  expect(await db().select().from(deletionLedger)).toHaveLength(1);
});
