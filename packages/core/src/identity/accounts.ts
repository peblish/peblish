import { localActorUrls } from '@peblish/schema/actor-urls';
import type { Uuid } from '@peblish/schema/ids';
import { uuidv7 } from 'uuidv7';
import { localInstance } from '../db/local-instance.ts';
import { actorKeys, actors } from '../db/tables/actors.ts';
import { authAccount, authUser } from '../db/tables/auth.ts';
import type { WriteTx } from '../db/write.ts';
import { Refused } from '../tx/refused.ts';
import { ageDeclarations } from './tables.ts';

export type NewAccount = {
  name: string;
  /** Lowercased, as better-auth stores and looks up emails. */
  email: string;
  /** From better-auth's own hasher (register.ts), so its sign-in verifies it. */
  passwordHash: string;
  keys: { publicKeyPem: string; privateKeyPem: string };
  role: 'user' | 'admin';
  emailVerified: boolean;
};

/** The unique constraint a Postgres error (possibly wrapped by Drizzle) violated, if any. */
export function uniqueViolation(error: unknown): string | undefined {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ('code' in cause && cause.code === '23505' && 'constraint_name' in cause) return String(cause.constraint_name);
  }
  return undefined;
}

/**
 * Writes one local account inside a mutation's transaction: the better-auth user and its
 * credential account (the rows better-auth's own sign-up would write), the Person actor with
 * its endpoints and RSA-2048 key, and the 16+ declaration. A name or email that a concurrent
 * registration took first is refused with its reason, not a raw unique violation.
 */
export async function insertAccount(db: WriteTx, action: string, account: NewAccount): Promise<{ userId: Uuid; actorId: Uuid }> {
  const instance = await localInstance(db);
  const userId = uuidv7();
  const actorId = uuidv7();
  const urls = localActorUrls(instance.origin, 'Person', account.name);
  const now = new Date();
  try {
    await db.insert(authUser).values({
      id: userId,
      name: account.name,
      email: account.email,
      emailVerified: account.emailVerified,
      role: account.role,
      twoFactorEnabled: false,
    });
    await db.insert(actors).values({
      id: actorId,
      apId: urls.apId,
      kind: 'Person',
      local: true,
      instanceId: instance.id,
      name: account.name,
      inboxUrl: urls.inbox,
      outboxUrl: urls.outbox,
      followersUrl: urls.followers,
      sharedInboxUrl: urls.sharedInbox,
      userId,
      publishedAt: now,
    });
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (constraint === 'auth_user_email_unique') throw new Refused(action, 'email.taken');
    if (constraint === 'actors_local_name_unique' || constraint === 'actors_ap_id_unique') throw new Refused(action, 'name.taken');
    throw error;
  }
  await db.insert(authAccount).values({ accountId: userId, providerId: 'credential', userId, password: account.passwordHash });
  await db.insert(actorKeys).values({ actorId, keyId: urls.keyId, algorithm: 'rsa', ...account.keys });
  await db.insert(ageDeclarations).values({ actorId, declaredAt: now });
  return { userId, actorId };
}
