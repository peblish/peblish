import { db } from '@peblish/core/db/read';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { and, eq } from 'drizzle-orm';
import type { SigningKey } from './sign.ts';

/**
 * The key the instance signs its own requests with: the instance actor's (the Application at the
 * origin's root, whose key migrate creates). Document fetches are signed with it, since they are
 * not on behalf of a person. Null when the instance actor has no private RSA key (a fresh test
 * database), in which case a fetch goes out unsigned.
 */
export async function instanceSigningKey(): Promise<SigningKey | null> {
  const [key] = await db()
    .select({ keyId: actorKeys.keyId, privateKeyPem: actorKeys.privateKeyPem })
    .from(actorKeys)
    .innerJoin(actors, eq(actors.id, actorKeys.actorId))
    .where(and(eq(actors.local, true), eq(actors.kind, 'Application'), eq(actorKeys.algorithm, 'rsa')));
  return key?.privateKeyPem ? { keyId: key.keyId, privateKeyPem: key.privateKeyPem } : null;
}
