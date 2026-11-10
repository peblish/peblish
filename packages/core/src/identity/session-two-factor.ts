import type { Uuid } from '@peblish/schema/ids';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { authSession } from '../db/tables/auth.ts';
import { writer } from '../db/write.ts';
import { sessionTwoFactor } from './tables.ts';

// Two-factor assurance per session (B07 A1). The account's two_factor_enabled says the person
// set a second factor up; it does not say this session used it. A session signed in with the
// password before two-factor was turned on would otherwise become an admin's the moment it
// was. So admin authority (SessionView.siteRole) needs the session's own session_two_factor
// row, which only these paths write:
// - better-auth's sign-in challenge (verify-totp, verify-backup-code without a session) and a
//   confirmed TOTP setup (verify-totp with one) both create the session they hand out; the
//   plugin below marks it;
// - a password change replaces the session (changePasswordAs, two-factor.ts), and carries
//   the mark over.

/** better-auth's endpoints that create a session for a code they accepted. */
const verifyPaths = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

/** Marks `sessionId` as having passed two-factor. */
export async function markSession(sessionId: Uuid): Promise<void> {
  await writer().insert(sessionTwoFactor).values({ sessionId }).onConflictDoNothing();
}

/** Whether the session passed two-factor (itself, or the session it replaced). */
export async function sessionPassedTwoFactor(sessionId: Uuid): Promise<boolean> {
  const [row] = await db()
    .select({ id: sessionTwoFactor.sessionId })
    .from(sessionTwoFactor)
    .where(eq(sessionTwoFactor.sessionId, sessionId));
  return row !== undefined;
}

/** The id of the session a token names, or null. */
export async function sessionIdOf(token: string): Promise<Uuid | null> {
  const [row] = await db().select({ id: authSession.id }).from(authSession).where(eq(authSession.token, token));
  return row?.id ?? null;
}

/** Signs every session of the user out but `keep` (turning two-factor on, B07 A1). */
export async function endOtherSessions(userId: Uuid, keep: Uuid): Promise<void> {
  await writer()
    .delete(authSession)
    .where(and(eq(authSession.userId, userId), ne(authSession.id, keep)));
}

/**
 * Marks the session a two-factor verification created. After hooks run for refused calls
 * too (the response is the APIError then), and the sign-in challenge sets no new session
 * until the code is accepted, so a session here passed.
 */
export const sessionTwoFactorMarker = () =>
  ({
    id: 'peblish-session-two-factor',
    hooks: {
      after: [
        {
          matcher: (ctx) => verifyPaths.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const created = ctx.context.newSession;
            if (!created || ctx.context.returned instanceof APIError) return;
            await markSession(created.session.id);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
