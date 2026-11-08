import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { authSession, authUser } from '../db/tables/auth.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance } from '../testing/seed-a.ts';
import { auth } from './auth.ts';
import { recordingTransport, useMailTransport } from './mail.ts';

const mail = recordingTransport();

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
  mail.sent.length = 0;
  useMailTransport(mail);
});
afterEach(() => useMailTransport(undefined));

const linkIn = (text: string | undefined) => new URL(/https:\/\/\S+/.exec(text ?? '')?.[0] ?? 'about:blank');

test('verification links are mailed to our own page and verify for 24 hours', async () => {
  const mira = await seedAccount('mira', { emailVerified: false });
  await (await auth()).api.sendVerificationEmail({ body: { email: mira.email } });
  expect(mail.sent).toMatchObject([{ to: mira.email, from: 'a.peblish.test <no-reply@a.peblish.test>' }]);
  const link = linkIn(mail.sent[0]?.text);
  expect(link.origin + link.pathname).toBe('https://a.peblish.test/auth/verify');
  const token = link.searchParams.get('token') ?? '';
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { exp: number; iat: number };
  expect(payload.exp - payload.iat).toBe(24 * 60 * 60);
  await (await auth()).api.verifyEmail({ query: { token } });
  const [user] = await db().select({ emailVerified: authUser.emailVerified }).from(authUser).where(eq(authUser.id, mira.userId));
  expect(user?.emailVerified).toBe(true);
});

test('a password reset is mailed, needs 12 characters, and signs out every session', async () => {
  const mira = await seedAccount('mira');
  const api = (await auth()).api;
  await api.signInEmail({ body: { email: mira.email, password: mira.password } });
  await api.requestPasswordReset({ body: { email: mira.email } });
  const link = linkIn(mail.sent[0]?.text);
  expect(link.pathname).toBe('/auth/reset');
  const token = link.searchParams.get('token') ?? '';
  await expect(api.resetPassword({ body: { token, newPassword: 'eleven char' } })).rejects.toThrow(/too short/i);
  await api.resetPassword({ body: { token, newPassword: 'a brand new passphrase' } });
  expect(await db().select().from(authSession).where(eq(authSession.userId, mira.userId))).toEqual([]);
  await expect(api.signInEmail({ body: { email: mira.email, password: mira.password } })).rejects.toThrow();
  await api.signInEmail({ body: { email: mira.email, password: 'a brand new passphrase' } });
});

test("better-auth's own sign-up is off: accounts come from account.register only", async () => {
  await expect(
    (await auth()).api.signUpEmail({ body: { email: 'x@example.test', password: 'twelve chars ok', name: 'x' } }),
  ).rejects.toThrow();
  expect(await db().select().from(authUser)).toEqual([]);
});
