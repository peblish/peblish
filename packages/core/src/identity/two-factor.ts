import { createOTP } from '@better-auth/utils/otp';
import type { Uuid } from '@peblish/schema/ids';
import { symmetricDecrypt } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { authTwoFactor } from '../db/tables/auth.ts';
import { auth } from './auth.ts';

// The security page's TOTP setup is three server-rendered steps (scan, confirm, save codes),
// so the page can show a setup better-auth started (enableTwoFactor, unverified) and, once,
// the recovery codes after confirming. These read better-auth's own two-factor row.

/** The authenticator URI and key of a setup started but not yet confirmed with a code. */
export async function pendingTotp(userId: Uuid, email: string): Promise<{ uri: string; key: string } | null> {
  const [row] = await db()
    .select({ secret: authTwoFactor.secret, verified: authTwoFactor.verified })
    .from(authTwoFactor)
    .where(eq(authTwoFactor.userId, userId));
  if (!row || row.verified !== false) return null;
  const instance = await auth();
  const { secretConfig } = await instance.$context;
  const secret = await symmetricDecrypt({ key: secretConfig, data: row.secret });
  const issuer = instance.options.appName ?? 'peblish';
  const uri = createOTP(secret).url(issuer, email);
  return { uri, key: new URL(uri).searchParams.get('secret') ?? '' };
}

const revealKey = (userId: Uuid) => `peblish-recovery-codes:${userId}`;

/** Lets the next security page view show the recovery codes, within ten minutes. */
export async function revealRecoveryCodesOnce(userId: Uuid): Promise<void> {
  const { internalAdapter } = await (await auth()).$context;
  await internalAdapter.createVerificationValue({
    identifier: revealKey(userId),
    value: userId,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
}

/** The recovery codes if a reveal is pending, consuming it: they are shown once. */
export async function takeRecoveryCodes(userId: Uuid): Promise<string[] | null> {
  const instance = await auth();
  const { internalAdapter } = await instance.$context;
  if (!(await internalAdapter.consumeVerificationValue(revealKey(userId)))) return null;
  const { backupCodes } = await instance.api.viewBackupCodes({ body: { userId } });
  return backupCodes;
}
