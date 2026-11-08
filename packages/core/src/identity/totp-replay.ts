import { timingSafeEqual } from 'node:crypto';
import { createOTP } from '@better-auth/utils/otp';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { eq, lt } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { authTwoFactor } from '../db/tables/auth.ts';
import { writer } from '../db/write.ts';
import { totpSteps } from './tables.ts';

// better-auth's TOTP check accepts any code of the current 30-second step or its neighbours,
// as often as it is sent. This plugin runs before every verify-totp call (the sign-in
// challenge and the security page's setup confirmation) and lets a code through only for a
// step later than the last one the user got past with, claimed atomically, so one code
// opens one session. A code that matches no step goes on to better-auth, which counts the
// failure towards its lockout.

const PERIOD_MS = 30_000;

/** The step (of now - 1, now, now + 1, better-auth's window) whose code `code` is, or null. */
export async function totpStepOf(secret: string, code: string, now = Date.now()): Promise<number | null> {
  const otp = createOTP(secret);
  const current = Math.floor(now / PERIOD_MS);
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(await otp.hotp(step));
    const given = Buffer.from(code);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return step;
  }
  return null;
}

/** Records `step` as the user's newest; false when it, or a later one, was already used. */
export async function claimTotpStep(userId: string, step: number): Promise<boolean> {
  const claimed = await writer()
    .insert(totpSteps)
    .values({ userId, step })
    .onConflictDoUpdate({ target: totpSteps.userId, set: { step }, setWhere: lt(totpSteps.step, step) })
    .returning({ userId: totpSteps.userId });
  return claimed.length > 0;
}

/** better-auth's own refusal for a wrong code, so the pages show "try the newest one". */
const replayed = () => new APIError('UNAUTHORIZED', { code: 'INVALID_CODE', message: 'Invalid code' });

export const totpReplayGuard = () =>
  ({
    id: 'peblish-totp-replay',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/two-factor/verify-totp',
          handler: createAuthMiddleware(async (ctx) => {
            const code: unknown = ctx.body?.code;
            if (typeof code !== 'string') return;
            // Whose code: the signed-in user confirming a setup, or the user of the sign-in
            // challenge cookie, as better-auth's verifier resolves it. Unknown: it refuses.
            let userId = (await getSessionFromCtx(ctx))?.user.id;
            if (!userId) {
              const challenge = await ctx.getSignedCookie(ctx.context.createAuthCookie('two_factor').name, ctx.context.secret);
              if (!challenge) return;
              userId = (await ctx.context.internalAdapter.findVerificationValue(challenge))?.value;
            }
            if (!userId) return;
            const [row] = await db().select({ secret: authTwoFactor.secret }).from(authTwoFactor).where(eq(authTwoFactor.userId, userId));
            if (!row) return;
            const step = await totpStepOf(await symmetricDecrypt({ key: ctx.context.secretConfig, data: row.secret }), code);
            if (step !== null && !(await claimTotpStep(userId, step))) throw replayed();
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
