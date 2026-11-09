import { type } from 'arktype';
import { eq } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { authUser } from '../db/tables/auth.ts';
import { auth, authErrorCode } from './auth.ts';

export type VerifyOutcome = 'verified' | 'used' | 'expired' | 'invalid';

const Payload = type({ email: 'string' });

/** The address a verification token names, read without trusting it (better-auth verifies). */
function tokenEmail(token: string): string | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const payload = Payload(JSON.parse(Buffer.from(part, 'base64url').toString()));
    return payload instanceof type.errors ? undefined : payload.email.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Applies an emailed verification link and says which of the mock's states it ends in:
 * verified now, already used (the address was verified before), expired or invalid.
 */
export async function verifyEmailToken(token: string): Promise<VerifyOutcome> {
  const email = tokenEmail(token);
  if (!email) return 'invalid';
  const [user] = await db().select({ emailVerified: authUser.emailVerified }).from(authUser).where(eq(authUser.email, email));
  try {
    await (await auth()).api.verifyEmail({ query: { token } });
  } catch (error) {
    const code = authErrorCode(error);
    if (code === undefined) throw error;
    return code === 'TOKEN_EXPIRED' ? 'expired' : 'invalid';
  }
  return user?.emailVerified ? 'used' : 'verified';
}

/** n******@example.com: enough to recognise the address on the "check your email" page. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.min(6, Math.max(1, local.length - 1)))}@${domain}`;
}
