import { PASSWORD_MAX, PASSWORD_MIN } from '@peblish/schema/identity';
import type { Uuid } from '@peblish/schema/ids';
import type { RefusalReason } from '@peblish/schema/refusal';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { newRsaKeyPair } from '../actor-keys.ts';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { inviteUses, invites } from '../db/tables/site.ts';
import { insertAccount } from '../identity/accounts.ts';
import { auth } from '../identity/auth.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';

/**
 * Creates the account the policy allowed, in one transaction: auth user and credential,
 * Person actor and keypair, the 16+ declaration, the invite use (the chain: invite_uses links
 * the new actor to the invite, whose created_by is the referrer). The recheck re-runs the
 * policy with the invite row locked, so a revoke, the kill switch or the cap that changed
 * since authorize() is honoured.
 */
export const registerAccount = defineMutation({
  action: 'account.register',
  emits: ['actor.created', 'account.registered'],
  recheck: true,
  async run(t, grant, input: { passwordHash: string; keys: { publicKeyPem: string; privateKeyPem: string } }) {
    const { authority, subject } = grant;
    if (authority.kind !== 'system' || !authority.ref) throw new TypeError('account.register needs the invite as its authority ref');
    const inviteId = authority.ref;
    const account = await insertAccount(t.db, 'account.register', {
      name: subject.name,
      email: subject.email,
      passwordHash: input.passwordHash,
      keys: input.keys,
      role: 'user',
      emailVerified: false,
    });
    // One statement guards the count; the recheck already holds the row, so this only fails on a bug.
    const used = await t.db
      .update(invites)
      .set({ useCount: sql`${invites.useCount} + 1` })
      .where(
        and(
          eq(invites.id, inviteId),
          isNull(invites.revokedAt),
          lt(invites.useCount, invites.maxUses),
          or(isNull(invites.expiresAt), gt(invites.expiresAt, sql`now()`)),
        ),
      )
      .returning({ id: invites.id });
    if (used.length === 0) throw new Refused('account.register', 'invite.exhausted');
    await t.db.insert(inviteUses).values({ inviteId, actorId: account.actorId });
    await t.emit({ type: 'actor.created', v: 1, actorId: account.actorId, kind: 'Person', local: true });
    await t.emit({ type: 'account.registered', v: 1, actorId: account.actorId, userId: account.userId, inviteId });
    return account;
  },
});

export type RegisterInput = {
  inviteCode: string;
  name: string;
  email: string;
  password: string;
  /** Computed by the caller from a date of birth that goes no further; null when none was given. */
  age: number | null;
};

export type RegisterResult = { ok: true; userId: Uuid; actorId: Uuid; email: string } | { ok: false; reason: RefusalReason };

/** better-auth's own hasher (scrypt), so its sign-in and password change verify the hash. */
export async function hashPassword(password: string): Promise<string> {
  const context = await (await auth()).$context;
  return context.password.hash(password);
}

/**
 * Sign-up as the instance (systemPrincipal 'registration'). The password hash and the
 * keypair are computed before the transaction opens, to keep it short. Signing in and the
 * verification email follow in the caller, after the commit.
 */
export async function register(input: RegisterInput): Promise<RegisterResult> {
  if (input.password.length < PASSWORD_MIN) return { ok: false, reason: 'password.too_short' };
  if (input.password.length > PASSWORD_MAX) return { ok: false, reason: 'password.too_long' };
  const email = input.email.trim().toLowerCase();
  const principal = await systemPrincipal(db(), 'registration');
  const decision = await authorize('account.register', principal, {
    inviteCode: input.inviteCode,
    name: input.name,
    email,
    age: input.age,
  });
  if (!decision.ok) return decision;
  const [passwordHash, keys] = await Promise.all([hashPassword(input.password), newRsaKeyPair()]);
  try {
    const account = await registerAccount(decision.grant, { passwordHash, keys });
    return { ok: true, ...account, email };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
}
