import { createPublicKey } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { actorKeys, actors } from '../db/tables/actors.ts';
import { authAccount, authUser } from '../db/tables/auth.ts';
import { outbox } from '../db/tables/outbox.ts';
import { inviteUses, invites } from '../db/tables/site.ts';
import { auth } from '../identity/auth.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedInvite, seedLocalInstance, seedSetting } from '../testing/seed-a.ts';
import { register, type RegisterInput } from './register.ts';
import { REGISTRATION_CAP_KEY } from './settings.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

const signUp = (inviteCode: string, overrides: Partial<RegisterInput> = {}) =>
  register({ inviteCode, name: 'mira', email: 'Mira@Example.test', password: 'twelve chars ok', age: 30, ...overrides });

test('sign-up with an invite writes the account, its keys, the chain and the declaration in one go', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  const invite = await seedInvite(andrew.actorId, { maxUses: 2 });
  const result = await signUp(invite.code.toLowerCase());
  if (!result.ok) throw new Error(result.reason);

  const [actor] = await db().select().from(actors).where(eq(actors.id, result.actorId));
  expect(actor).toMatchObject({ apId: 'https://a.peblish.test/ap/u.mira', kind: 'Person', local: true, userId: result.userId });
  const [key] = await db().select().from(actorKeys).where(eq(actorKeys.actorId, result.actorId));
  expect(key?.keyId).toBe('https://a.peblish.test/ap/u.mira#main-key');
  expect(createPublicKey(key!.publicKeyPem).asymmetricKeyDetails?.modulusLength).toBe(2048);
  expect(key?.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  const [user] = await db().select().from(authUser).where(eq(authUser.id, result.userId));
  expect(user).toMatchObject({ email: 'mira@example.test', emailVerified: false, role: 'user' });
  expect(await db().select().from(inviteUses)).toEqual([expect.objectContaining({ inviteId: invite.id, actorId: result.actorId })]);
  const [used] = await db().select({ useCount: invites.useCount, createdBy: invites.createdBy }).from(invites);
  expect(used).toEqual({ useCount: 1, createdBy: andrew.actorId });
  // The declaration is a timestamp, nothing more.
  const declarations = await db().select().from(ageDeclarations).where(eq(ageDeclarations.actorId, result.actorId));
  expect(declarations).toEqual([{ actorId: result.actorId, declaredAt: expect.any(Date) }]);
  const events = await db().select({ type: outbox.type, payload: outbox.payload }).from(outbox);
  expect(events.map(({ type }) => type)).toEqual(['actor.created', 'account.registered']);
  expect(events[1]?.payload).toMatchObject({ actorId: result.actorId, userId: result.userId, inviteId: invite.id });

  // The credential row is better-auth's own shape: its sign-in accepts the password.
  const [credential] = await db().select().from(authAccount).where(eq(authAccount.userId, result.userId));
  expect(credential).toMatchObject({ providerId: 'credential', accountId: result.userId });
  const signedIn = await (await auth()).api.signInEmail({ body: { email: 'mira@example.test', password: 'twelve chars ok' } });
  expect(signedIn.user.id).toBe(result.userId);
});

test('sign-up refuses with the exact reason and writes nothing', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  const valid = await seedInvite(andrew.actorId, { maxUses: 5 });
  const cases: [string, Promise<Awaited<ReturnType<typeof signUp>>>][] = [
    ['invite.unknown', signUp('PB-2222-2222')],
    ['invite.expired', seedInvite(andrew.actorId, { expiresAt: new Date(Date.now() - 1000) }).then(({ code }) => signUp(code))],
    ['invite.exhausted', seedInvite(andrew.actorId, { maxUses: 2, useCount: 2 }).then(({ code }) => signUp(code))],
    ['invite.revoked', seedInvite(andrew.actorId, { revokedAt: new Date() }).then(({ code }) => signUp(code))],
    ['age.under_16', signUp(valid.code, { age: 15 })],
    ['age.declaration_required', signUp(valid.code, { age: null })],
    ['name.invalid', signUp(valid.code, { name: 'mira-k' })],
    ['name.reserved', signUp(valid.code, { name: 'Admin' })],
    ['name.taken', signUp(valid.code, { name: 'ANDREW' })],
    ['email.taken', signUp(valid.code, { email: 'Andrew@example.test' })],
    ['email.invalid', signUp(valid.code, { email: 'mira' })],
    ['password.too_short', signUp(valid.code, { password: 'eleven char' })],
  ];
  for (const [reason, attempt] of cases) expect(await attempt, reason).toEqual({ ok: false, reason });

  await seedSetting(REGISTRATION_CAP_KEY, 1);
  expect(await signUp(valid.code)).toEqual({ ok: false, reason: 'registration.capped' });
  await seedSetting(REGISTRATION_CAP_KEY, 25);
  await seedSetting('registration.enabled', false);
  expect(await signUp(valid.code)).toEqual({ ok: false, reason: 'site.disabled' });

  expect(await db().select({ id: actors.id }).from(actors).where(eq(actors.kind, 'Person'))).toHaveLength(1);
  expect(await db().select().from(outbox)).toEqual([]);
});

test('two sign-ups racing for the last use of an invite: one account, the other refused', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  const invite = await seedInvite(andrew.actorId, { maxUses: 2, useCount: 1 });
  const results = await Promise.all([
    signUp(invite.code, { name: 'lena', email: 'lena@example.test' }),
    signUp(invite.code, { name: 'omar', email: 'omar@example.test' }),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'invite.exhausted' }]);
  const [row] = await db().select({ useCount: invites.useCount }).from(invites);
  expect(row?.useCount).toBe(2);
});

test('two sign-ups racing for the last cap slot: one account', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  await seedSetting(REGISTRATION_CAP_KEY, 2);
  const first = await seedInvite(andrew.actorId);
  const second = await seedInvite(andrew.actorId);
  const results = await Promise.all([
    signUp(first.code, { name: 'lena', email: 'lena@example.test' }),
    signUp(second.code, { name: 'omar', email: 'omar@example.test' }),
  ]);
  expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'registration.capped' }]);
});
