import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { authSession } from '../db/tables/auth.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance, seedTwoFactor, totpCode } from '../testing/seed-a.ts';
import { auth, authErrorCode } from './auth.ts';

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
