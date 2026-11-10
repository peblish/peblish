import { createOTP } from '@better-auth/utils/otp';
import type { Uuid } from '@peblish/schema/ids';
import { symmetricDecrypt } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { authTwoFactor, authUser } from '../db/tables/auth.ts';
import { auth } from './auth.ts';
import { endOtherSessions, markSession, sessionIdOf, sessionPassedTwoFactor } from './session-two-factor.ts';

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
async function revealRecoveryCodesOnce(userId: Uuid): Promise<void> {
  const { internalAdapter } = await (await auth()).$context;
  await internalAdapter.createVerificationValue({
    identifier: revealKey(userId),
    value: userId,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
}

/**
 * Confirms a started TOTP setup with a code from the app (the security page's step 2), and
 * lets the next page view show the recovery codes. Only a setup not yet confirmed can be, so
 * a code posted again later shows nothing. Turning two-factor on replaces this session with
 * one that passed it and signs every other session out (B07 A1): one signed in with the
 * password alone must not carry on as the account of someone with a second factor. Returns
 * better-auth's Set-Cookie values, or null when there was no setup to confirm.
 */
export async function confirmTotpSetup(userId: Uuid, headers: Headers, code: string): Promise<string[] | null> {
  const [setup] = await db()
    .select({ verified: authTwoFactor.verified, enabled: authUser.twoFactorEnabled })
    .from(authTwoFactor)
    .innerJoin(authUser, eq(authUser.id, authTwoFactor.userId))
    .where(eq(authTwoFactor.userId, userId));
  if (setup?.verified !== false || setup.enabled === true) return null;
  const api = (await auth()).api;
  const { headers: answer } = await api.verifyTOTP({ body: { code }, headers, returnHeaders: true });
  // verify-totp answers with the replaced session's token; the new one is in its cookie.
  const replacement = await api.getSession({ headers: new Headers({ cookie: cookieHeader(answer.getSetCookie()) }) });
  if (replacement) await endOtherSessions(userId, replacement.session.id);
  await revealRecoveryCodesOnce(userId);
  return answer.getSetCookie();
}

/** A Cookie header carrying the cookies a response sets. */
const cookieHeader = (setCookies: string[]) => setCookies.map((cookie) => cookie.split(';')[0]).join('; ');

/** The recovery codes if a reveal is pending, consuming it: they are shown once. */
export async function takeRecoveryCodes(userId: Uuid): Promise<string[] | null> {
  const instance = await auth();
  const { internalAdapter } = await instance.$context;
  if (!(await internalAdapter.consumeVerificationValue(revealKey(userId)))) return null;
  const { backupCodes } = await instance.api.viewBackupCodes({ body: { userId } });
  return backupCodes;
}

/**
 * better-auth's password change, ending every other session. The session it hands back keeps
 * this one's two-factor mark (session-two-factor.ts; the old mark goes with the old session).
 * Returns better-auth's Set-Cookie values; throws its APIError for a wrong or unacceptable password.
 */
export async function changePasswordAs(sessionId: Uuid, headers: Headers, passwords: { current: string; next: string }): Promise<string[]> {
  const passed = await sessionPassedTwoFactor(sessionId);
  const { headers: answer, response } = await (
    await auth()
  ).api.changePassword({
    body: { currentPassword: passwords.current, newPassword: passwords.next, revokeOtherSessions: true },
    headers,
    returnHeaders: true,
  });
  const replacement = response.token ? await sessionIdOf(response.token) : null;
  if (passed && replacement) await markSession(replacement);
  return answer.getSetCookie();
}
