import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { PASSWORD_MAX, PASSWORD_MIN } from '@peblish/schema/identity';
import { uuidv7 } from 'uuidv7';
import { localInstance } from '../db/local-instance.ts';
import { db } from '../db/read.ts';
import { authAccount, authSession, authTwoFactor, authUser, authVerification } from '../db/tables/auth.ts';
import { writer } from '../db/write.ts';
import { sendMail } from './mail.ts';
import { totpReplayGuard } from './totp-replay.ts';

// The better-auth instance (lane A). It lives in core because only core may hold the write
// pool (lint rule core-writer-access names core/identity for it); web reaches it through
// w/server/auth.ts. better-auth writes its own tables (auth_*); everything else an account
// owns (actor, keys, invite use, declaration, deletion) goes through mutations.
//
// No better-auth HTTP endpoint is mounted: web's form handlers call auth.api directly, so
// sign-up cannot bypass the invite gate (disableSignUp) and every flow has our own page.
//
// Site role convention: auth_user.role is 'user' or 'admin', better-auth's admin-plugin
// spelling (the plugin itself is not used). The admin bootstrap (identity/admin-cli.ts) sets
// 'admin'; an admin counts as one only with two-factor on (SessionView.siteRole).

/** Development hosts (as config.ts treats them) may run without BETTER_AUTH_SECRET. */
const DEV_SECRET = 'peblish-development-secret-never-use-in-production';

function secretFor(origin: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (secret) {
    if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
    return secret;
  }
  const host = new URL(origin).hostname;
  if (host === 'localhost' || host.endsWith('.test')) return DEV_SECRET;
  throw new Error(`BETTER_AUTH_SECRET is unset; ${host} needs a random value of 32 characters or more`);
}

/** Links in mail point at our own pages, under the instance origin. */
export const verifyEmailPath = '/auth/verify';
export const resetPasswordPath = '/auth/reset';

function createAuth(origin: string) {
  const host = new URL(origin).host;
  return betterAuth({
    appName: host,
    baseURL: origin,
    basePath: '/auth/api',
    secret: secretFor(origin),
    database: drizzleAdapter(writer(), {
      provider: 'pg',
      schema: { user: authUser, session: authSession, account: authAccount, verification: authVerification, twoFactor: authTwoFactor },
    }),
    advanced: {
      database: { generateId: () => uuidv7() },
      cookiePrefix: 'peblish',
      useSecureCookies: origin.startsWith('https://'),
      // Reset mail goes out detached (better-auth logs a failure), so a reset request answers
      // as fast for an address with an account as for one without: no timing tells them apart.
      backgroundTasks: { handler: (task) => void task },
    },
    emailAndPassword: {
      enabled: true,
      // Accounts are created by account.register (invite, cap, 16+ declaration) only.
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      // No breached-password check: the one on offer (haveibeenpwned) is a network call per password.
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      // Runs as a background task (advanced.backgroundTasks).
      async sendResetPassword({ user, token }) {
        const link = new URL(`${resetPasswordPath}?token=${encodeURIComponent(token)}`, origin).href;
        await sendMail(
          {
            to: user.email,
            subject: `Reset your ${host} password`,
            text: `Someone asked to reset the password of your ${host} account.\n\nChoose a new password here (the link works for one hour):\n${link}\n\nIf it was not you, ignore this email; your password stays as it is.\n`,
          },
          host,
        );
      },
    },
    emailVerification: {
      expiresIn: 24 * 60 * 60,
      async sendVerificationEmail({ user, token }) {
        const link = new URL(`${verifyEmailPath}?token=${encodeURIComponent(token)}`, origin).href;
        await sendMail(
          {
            to: user.email,
            subject: `Verify your email for ${host}`,
            text: `Welcome to ${host}.\n\nConfirm this address to start posting (the link works for 24 hours):\n${link}\n\nIf you did not create an account, ignore this email.\n`,
          },
          host,
        );
      },
    },
    session: { expiresIn: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    // The replay guard runs before the plugin's verify-totp: one code, one session.
    plugins: [twoFactor({ issuer: host, backupCodeOptions: { amount: 10, length: 10 } }), totpReplayGuard()],
    // Direct auth.api calls skip better-auth's limiter anyway (it runs in its HTTP router).
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

declare global {
  // On globalThis like the pools: the web build carries two copies of this module.
  var peblishAuth: { handle: object; auth: Promise<Auth> } | undefined;
}

/**
 * The instance, created on first use for the local instance's origin (migrate stores it), so
 * links and cookies follow the canonical origin. Rebuilt when the write pool is (tests close
 * the pools between files).
 */
export function auth(): Promise<Auth> {
  const handle = writer();
  const cached = globalThis.peblishAuth;
  if (cached?.handle === handle) return cached.auth;
  const created = localInstance(db()).then(({ origin }) => createAuth(origin));
  globalThis.peblishAuth = { handle, auth: created };
  created.catch(() => {
    if (globalThis.peblishAuth?.auth === created) globalThis.peblishAuth = undefined;
  });
  return created;
}

/** The code a better-auth APIError carries (body.code, such as INVALID_CODE), or undefined. */
export function authErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('body' in error)) return undefined;
  const body = error.body;
  return typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? body.code : undefined;
}
