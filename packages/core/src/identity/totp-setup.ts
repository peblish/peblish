import { createHmac } from 'node:crypto';
import { base32 } from '@better-auth/utils/base32';
import type { Uuid } from '@peblish/schema/ids';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { eq, like } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { authTwoFactor, authUser, authVerification } from '../db/tables/auth.ts';
import { writer } from '../db/write.ts';
import { endOtherSessions } from './session-two-factor.ts';

// Who a TOTP setup in progress belongs to (B07 A2). better-auth keeps one two-factor row per
// account and overwrites its unconfirmed secret whenever a session starts again, so ownership
// is recorded per secret: the verification row's identifier carries a fingerprint of the key
// the starting session was given (review 2 AN2). A session sees and may confirm the setup only
// while the row's current secret is the one it started; a restart by another session makes a
// new secret, whose fingerprint no earlier owner holds, before anyone is recorded as its owner.
// Rows go in better-auth's verification table, which it cleans once expired. totpSetupGuard
// below applies these rules to every call of better-auth's verifiers (review 2 AN1).

/** The auth instance's keys these need: `$context` of the better-auth instance, or a hook's `ctx.context`. */
export type SetupKeys = { secret: string; secretConfig: Parameters<typeof symmetricDecrypt>[0]['key'] };

/** How long a started setup stays on offer to its session; after that, starting again makes a new key. */
const setupMs = 60 * 60_000;

const ownerPrefix = (userId: Uuid) => `peblish-totp-setup:${userId}:`;

/** HMAC of the authenticator key under the auth secret: names the secret, reveals nothing of it. */
const fingerprint = (keys: SetupKeys, key: string) =>
  createHmac('sha256', keys.secret).update(`peblish:totp-setup:${key}`).digest('base64url');

/** The base32 key an authenticator URI carries: what the page shows, and the fingerprint's input. */
const keyOfUri = (uri: string) => new URL(uri).searchParams.get('secret') ?? '';

/** The base32 key of a raw secret, as better-auth's authenticator URI spells it. */
const keyOf = (secret: string) => base32.encode(secret, { padding: false });

/**
 * Records `sessionId` as the owner of the setup whose authenticator URI it was just given
 * (better-auth's enableTwoFactor answer), replacing every earlier owner of the account's setups.
 */
export async function recordSetupOwner(keys: SetupKeys, userId: Uuid, sessionId: Uuid, totpUri: string): Promise<void> {
  await clearSetupOwners(userId);
  await writer()
    .insert(authVerification)
    .values({
      identifier: ownerPrefix(userId) + fingerprint(keys, keyOfUri(totpUri)),
      value: sessionId,
      expiresAt: new Date(Date.now() + setupMs),
    });
}

/**
 * The account's unconfirmed setup (its raw secret and base32 key) when `sessionId` owns its
 * current secret, within setupMs; otherwise null.
 */
export async function ownedSetup(keys: SetupKeys, userId: Uuid, sessionId: Uuid): Promise<{ secret: string; key: string } | null> {
  const [row] = await db()
    .select({ secret: authTwoFactor.secret, verified: authTwoFactor.verified, enabled: authUser.twoFactorEnabled })
    .from(authTwoFactor)
    .innerJoin(authUser, eq(authUser.id, authTwoFactor.userId))
    .where(eq(authTwoFactor.userId, userId));
  if (!row || row.verified !== false || row.enabled === true) return null;
  const secret = await symmetricDecrypt({ key: keys.secretConfig, data: row.secret });
  const key = keyOf(secret);
  const [owner] = await db()
    .select({ value: authVerification.value, expiresAt: authVerification.expiresAt })
    .from(authVerification)
    .where(eq(authVerification.identifier, ownerPrefix(userId) + fingerprint(keys, key)));
  return owner?.value === sessionId && owner.expiresAt.getTime() > Date.now() ? { secret, key } : null;
}

/** Forgets every owner of the account's setups (once one is confirmed). */
export async function clearSetupOwners(userId: Uuid): Promise<void> {
  await writer()
    .delete(authVerification)
    .where(like(authVerification.identifier, `${ownerPrefix(userId)}%`));
}

/** Where the session a confirmation hands out finds its one-time reveal of the recovery codes. */
export const revealKey = (sessionId: Uuid) => `peblish-recovery-codes:${sessionId}`;

/** better-auth's endpoints that accept a second-factor code. */
const verifyPaths = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code', '/two-factor/verify-otp']);

/** The refusal for a code sent with a session that owns no setup in progress. */
const notThisSession = () =>
  new APIError('FORBIDDEN', { code: 'TOTP_SETUP_NOT_THIS_SESSION', message: 'This session has no two-factor setup to confirm' });

/**
 * The enrolment rules, on every call of better-auth's verifiers whichever page makes it
 * (review 2 AN1). better-auth takes a call that carries a session as that account confirming
 * its setup, so:
 * - before: with a session, only verify-totp goes on, and only for a setup this session owns
 *   (ownedSetup: its current secret, within the hour). A call without a session is the sign-in
 *   challenge and goes on as before.
 * - after: once a confirmation turned two-factor on, every other session of the account ends
 *   (B07 A1), the setup's owners are forgotten, and the session it handed out may show the
 *   recovery codes once, within ten minutes.
 * Registered before the replay guard, so a refused code does not use up its step.
 */
export const totpSetupGuard = () =>
  ({
    id: 'peblish-totp-setup',
    hooks: {
      before: [
        {
          matcher: (ctx) => verifyPaths.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            if (ctx.path !== '/two-factor/verify-totp' || !(await ownedSetup(ctx.context, session.user.id, session.session.id)))
              throw notThisSession();
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === '/two-factor/verify-totp',
          handler: createAuthMiddleware(async (ctx) => {
            // The request's session (the one confirming) stays in ctx.context.session; better-auth
            // put the session that replaces it in newSession. The sign-in challenge has no session.
            const confirming = ctx.context.session;
            const created = ctx.context.newSession;
            if (ctx.context.returned instanceof APIError || !confirming || !created) return;
            const userId = created.user.id;
            await endOtherSessions(userId, created.session.id);
            await clearSetupOwners(userId);
            await writer()
              .insert(authVerification)
              .values({ identifier: revealKey(created.session.id), value: userId, expiresAt: new Date(Date.now() + 10 * 60_000) });
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
