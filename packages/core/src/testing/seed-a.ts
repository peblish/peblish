import { createHmac } from 'node:crypto';
import { symmetricEncrypt } from 'better-auth/crypto';
import type { Uuid } from '@peblish/schema/ids';
import { and, eq, sql } from 'drizzle-orm';
import { newRsaKeyPair } from '../actor-keys.ts';
import { ensureLocalInstance } from '../db/bootstrap.ts';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { authAccount, authTwoFactor, authUser } from '../db/tables/auth.ts';
import { outbox } from '../db/tables/outbox.ts';
import { deletionLedger, invites, siteSettings } from '../db/tables/site.ts';
import { writer } from '../db/write.ts';
import { insertAccount } from '../identity/accounts.ts';
import { auth } from '../identity/auth.ts';
import { throttles, totpSteps } from '../identity/tables.ts';
import { hashInviteCode, newInviteCode } from '../registration/codes.ts';
import { hashPassword } from '../registration/register.ts';
import { REGISTRATION_CAP_KEY } from '../registration/settings.ts';

// Lane A's seeds: the local instance, accounts with sessions, two-factor and keys, invites.
// Tests import the functions; e2e runs this file (`node packages/core/src/testing/seed-a.ts
// e2e-admin`) to get an admin with a known password and TOTP secret on the lane database.

export const ORIGIN = 'https://a.peblish.test';
export const PASSWORD = 'correct horse battery staple';

export async function seedLocalInstance(origin = ORIGIN): Promise<void> {
  await ensureLocalInstance(writer(), origin);
}

/** A local account as registration would write it, keys and declaration included. */
export async function seedAccount(name: string, options: { role?: 'user' | 'admin'; emailVerified?: boolean; password?: string } = {}) {
  const [passwordHash, keys] = await Promise.all([hashPassword(options.password ?? PASSWORD), newRsaKeyPair()]);
  const email = `${name.toLowerCase()}@example.test`;
  const account = await writer().transaction((tx) =>
    insertAccount(tx, 'seed', {
      name,
      email,
      passwordHash,
      keys,
      role: options.role ?? 'user',
      emailVerified: options.emailVerified ?? true,
    }),
  );
  return { ...account, name, email, password: options.password ?? PASSWORD };
}

/** RFC 6238 code for a better-auth TOTP secret (its raw string is the HMAC key). */
export function totpCode(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 15;
  return String(mac.readUInt32BE(offset) & 0x7fffffff)
    .slice(-6)
    .padStart(6, '0');
}

/** Turns two-factor on with a known secret and recovery codes, as better-auth stores them. */
export async function seedTwoFactor(userId: Uuid, secret = 'peblish-seed-totp-secret-0123456') {
  const { secretConfig } = await (await auth()).$context;
  const backupCodes = Array.from({ length: 10 }, (_, i) => `seed${i}-backup`);
  const row = {
    secret: await symmetricEncrypt({ key: secretConfig, data: secret }),
    backupCodes: await symmetricEncrypt({ key: secretConfig, data: JSON.stringify(backupCodes) }),
    verified: true,
    failedVerificationCount: 0,
    lockedUntil: null,
  };
  await writer().transaction(async (tx) => {
    await tx.delete(authTwoFactor).where(eq(authTwoFactor.userId, userId));
    // A new secret: codes of the old one no longer count as used.
    await tx.delete(totpSteps).where(eq(totpSteps.userId, userId));
    await tx.insert(authTwoFactor).values({ userId, ...row });
    await tx.update(authUser).set({ twoFactorEnabled: true }).where(eq(authUser.id, userId));
  });
  return { secret, backupCodes };
}

export async function seedInvite(
  referrerId: Uuid,
  options: { maxUses?: number; useCount?: number; expiresAt?: Date | null; revokedAt?: Date | null; label?: string } = {},
) {
  const code = newInviteCode();
  const [row] = await writer()
    .insert(invites)
    .values({
      codeHash: await hashInviteCode(code),
      createdBy: referrerId,
      maxUses: options.maxUses ?? 1,
      useCount: options.useCount ?? 0,
      note: options.label ?? null,
      expiresAt: options.expiresAt ?? null,
      revokedAt: options.revokedAt ?? null,
    })
    .returning({ id: invites.id });
  if (!row) throw new Error('invite insert returned nothing');
  return { id: row.id, code };
}

export async function seedSetting(key: string, value: unknown): Promise<void> {
  await writer().insert(siteSettings).values({ key, value }).onConflictDoUpdate({ target: siteSettings.key, set: { value } });
}

/**
 * The e2e admin on the lane database, created once and reset on every run: known password,
 * two-factor on with a known secret, a cap high enough for repeated runs, and no throttle
 * counts left from earlier runs.
 */
async function e2eAdmin() {
  const name = 'e2e_admin';
  const [existing] = await writer().select({ actorId: actors.id, userId: actors.userId }).from(actors).where(eq(actors.name, name));
  let userId = existing?.userId;
  if (!userId) userId = (await seedAccount(name, { role: 'admin' })).userId;
  else
    await writer()
      .update(authAccount)
      .set({ password: await hashPassword(PASSWORD) })
      .where(eq(authAccount.userId, userId));
  const { secret, backupCodes } = await seedTwoFactor(userId, 'peblish-e2e-admin-totp-secret-01');
  await seedSetting(REGISTRATION_CAP_KEY, 100_000);
  // Every run signs in from 127.0.0.1 and tries wrong passwords: start each with fresh budgets.
  await writer().delete(throttles);
  return { name, email: `${name}@example.test`, password: PASSWORD, totpSecret: secret, backupCodes };
}

/** What account deletion left behind for `name`, for the e2e deletion check. */
async function deletionRecord(name: string) {
  const [actor] = await db()
    .select({ id: actors.id, deletedAt: actors.deletedAt, userId: actors.userId })
    .from(actors)
    .where(eq(actors.name, name));
  if (!actor) throw new Error(`no actor ${name}`);
  const ledger = await db().select({ id: deletionLedger.id }).from(deletionLedger).where(eq(deletionLedger.subjectId, actor.id));
  const events = await db()
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(eq(outbox.type, 'actor.deleted'), sql`${outbox.payload}->>'actorId' = ${actor.id}`));
  return { deleted: actor.deletedAt !== null, login: actor.userId !== null, ledgerRows: ledger.length, deletedEvents: events.length };
}

if (import.meta.main) {
  try {
    const [command, name] = process.argv.slice(2);
    if (command === 'e2e-admin') console.log(JSON.stringify(await e2eAdmin()));
    else if (command === 'deleted' && name) console.log(JSON.stringify(await deletionRecord(name)));
    else throw new Error('usage: node packages/core/src/testing/seed-a.ts e2e-admin | deleted <name>');
  } finally {
    await closePools();
  }
}
