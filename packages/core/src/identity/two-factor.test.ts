import { symmetricDecrypt } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { authSession, authTwoFactor } from '../db/tables/auth.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance, seedTwoFactor, totpCode } from '../testing/seed-a.ts';
import { auth, authErrorCode } from './auth.ts';
import { currentSession } from './session.ts';
import { confirmTotpSetup, startTotpSetup } from './two-factor.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

/** Signs in with the password: a two-factor account gets the challenge cookie, sent back as `cookie`. */
async function challenge(email: string, password: string): Promise<Headers> {
  const { headers } = await (await auth()).api.signInEmail({ body: { email, password }, returnHeaders: true });
  return new Headers({
    cookie: headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  });
}

const refusal = (attempt: Promise<unknown>) => attempt.then(() => 'accepted', authErrorCode);

test('one TOTP code opens one session: a second challenge with it is refused, the next step still works', async () => {
  const mira = await seedAccount('mira');
  const { secret } = await seedTwoFactor(mira.userId);
  const api = (await auth()).api;
  const now = Date.now();
  const code = totpCode(secret, now);

  await api.verifyTOTP({ body: { code }, headers: await challenge(mira.email, mira.password) });
  const second = await challenge(mira.email, mira.password);
  expect(await refusal(api.verifyTOTP({ body: { code }, headers: second }))).toBe('INVALID_CODE');
  await api.verifyTOTP({ body: { code: totpCode(secret, now + 30_000) }, headers: second });
  expect(await db().select().from(authSession).where(eq(authSession.userId, mira.userId))).toHaveLength(2);
});

test('two challenges racing with one code: one session', async () => {
  const mira = await seedAccount('mira');
  const { secret } = await seedTwoFactor(mira.userId);
  const api = (await auth()).api;
  const code = totpCode(secret);
  const [a, b] = [await challenge(mira.email, mira.password), await challenge(mira.email, mira.password)];
  const outcomes = await Promise.all([
    refusal(api.verifyTOTP({ body: { code }, headers: a })),
    refusal(api.verifyTOTP({ body: { code }, headers: b })),
  ]);
  expect(outcomes.sort()).toEqual(['INVALID_CODE', 'accepted']);
  expect(await db().select().from(authSession).where(eq(authSession.userId, mira.userId))).toHaveLength(1);
});

test('a recovery code works once', async () => {
  const mira = await seedAccount('mira');
  const { backupCodes } = await seedTwoFactor(mira.userId);
  const api = (await auth()).api;
  const code = backupCodes[0] ?? '';
  await api.verifyBackupCode({ body: { code }, headers: await challenge(mira.email, mira.password) });
  const again = api.verifyBackupCode({ body: { code }, headers: await challenge(mira.email, mira.password) });
  expect(await refusal(again)).toBe('INVALID_BACKUP_CODE');
});

/** The account's two-factor row as stored: secret and recovery codes, each opened with the auth secret. */
async function storedTwoFactor(userId: string) {
  const [row] = await db().select().from(authTwoFactor).where(eq(authTwoFactor.userId, userId));
  const key = (await (await auth()).$context).secretConfig;
  const open = (sealed: string) => symmetricDecrypt({ key, data: sealed });
  return { raw: row!.backupCodes, secret: await open(row!.secret), codes: JSON.parse(await open(row!.backupCodes)) as string[] };
}

test('recovery codes are stored sealed with the auth secret, at setup and after one is used', async () => {
  const mira = await seedAccount('mira');
  const cookies = await challenge(mira.email, mira.password);
  const sessionId = (await currentSession(cookies))!.sessionId;
  await startTotpSetup(sessionId, mira.userId, cookies, mira.password);

  // Sealed as better-auth seals the TOTP secret: hex of XChaCha20-Poly1305 output, never JSON.
  const setup = await storedTwoFactor(mira.userId);
  expect(setup.raw).toMatch(/^[0-9a-f]+$/);
  expect(setup.codes).toHaveLength(10);
  await confirmTotpSetup(mira.userId, sessionId, cookies, totpCode(setup.secret));

  const [used, ...rest] = setup.codes;
  await (await auth()).api.verifyBackupCode({ body: { code: used! }, headers: await challenge(mira.email, mira.password) });
  const after = await storedTwoFactor(mira.userId);
  expect(after.raw).toMatch(/^[0-9a-f]+$/);
  expect(after.codes).toEqual(rest);
});
