import type { RefusalReason } from '@peblish/schema/refusal';
import { PASSWORD_MAX, PASSWORD_MIN } from '@peblish/schema/identity';
import { newRsaKeyPair } from '../actor-keys.ts';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { hashPassword } from '../registration/register.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { insertAccount } from './accounts.ts';

/**
 * The instance's first site admin (the beta has one: Andrew). It is the root of the invite
 * chain, so it uses no invite; its email counts as verified because the operator typed it.
 * The admin then turns on two-factor before any admin action works (A03).
 */
export const bootstrapAdminAccount = defineMutation({
  action: 'account.bootstrap_admin',
  emits: ['actor.created', 'account.registered'],
  recheck: true,
  async run(t, grant, input: { passwordHash: string; keys: { publicKeyPem: string; privateKeyPem: string } }) {
    const account = await insertAccount(t.db, 'account.bootstrap_admin', {
      ...grant.subject,
      ...input,
      role: 'admin',
      emailVerified: true,
    });
    await t.emit({ type: 'actor.created', v: 1, actorId: account.actorId, kind: 'Person', local: true });
    await t.emit({ type: 'account.registered', v: 1, actorId: account.actorId, userId: account.userId, inviteId: null });
    return account;
  },
});

export async function bootstrapAdmin(input: {
  name: string;
  email: string;
  password: string;
}): Promise<{ ok: true; actorId: string } | { ok: false; reason: RefusalReason }> {
  if (input.password.length < PASSWORD_MIN) return { ok: false, reason: 'password.too_short' };
  if (input.password.length > PASSWORD_MAX) return { ok: false, reason: 'password.too_long' };
  const principal = await systemPrincipal(db(), 'registration');
  const decision = await authorize('account.bootstrap_admin', principal, { name: input.name, email: input.email.trim().toLowerCase() });
  if (!decision.ok) return decision;
  const [passwordHash, keys] = await Promise.all([hashPassword(input.password), newRsaKeyPair()]);
  try {
    const { actorId } = await bootstrapAdminAccount(decision.grant, { passwordHash, keys });
    return { ok: true, actorId };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
}
