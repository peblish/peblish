import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { authSession } from '../db/tables/auth.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance, seedTwoFactor, totpCode } from '../testing/seed-a.ts';
import { auth } from './auth.ts';
import { bootstrapAdmin } from './bootstrap.ts';
import { currentSession, describeDevice, deviceSessions, maskIp, revokeSession } from './session.ts';
import { confirmTotpSetup, pendingTotp, takeRecoveryCodes } from './two-factor.ts';

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

const firefoxMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0';
const safariPhone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

async function signIn(email: string, password: string, userAgent: string): Promise<Headers> {
  const { headers } = await (
    await auth()
  ).api.signInEmail({
    body: { email, password },
    headers: new Headers({ 'user-agent': userAgent, 'x-forwarded-for': '203.0.113.7' }),
    returnHeaders: true,
  });
  return new Headers({
    cookie: headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  });
}

test('sessions list their device, and one can be revoked by its owner only', async () => {
  const mira = await seedAccount('mira');
  const lena = await seedAccount('lena');
  const laptop = await signIn(mira.email, mira.password, firefoxMac);
  await signIn(mira.email, mira.password, safariPhone);
  const current = await currentSession(laptop);
  if (!current) throw new Error('not signed in');

  const sessions = await deviceSessions(mira.userId, current.sessionId);
  expect(sessions).toHaveLength(2);
  expect(sessions.find((session) => session.current)).toMatchObject({ browser: 'Firefox', os: 'macOS', ip: '203.0.113.x' });
  const phone = sessions.find((session) => !session.current);
  expect(phone).toMatchObject({ browser: 'Safari', os: 'iOS' });

  expect(await revokeSession(lena.userId, phone!.id)).toBe(false);
  expect(await revokeSession(mira.userId, phone!.id)).toBe(true);
  expect((await deviceSessions(mira.userId, current.sessionId)).map(({ id }) => id)).toEqual([current.sessionId]);
});

test('a session older than a day comes back with a refreshed cookie for the reply to pass on', async () => {
  const mira = await seedAccount('mira');
  const cookies = await signIn(mira.email, mira.password, firefoxMac);
  expect((await currentSession(cookies))?.setCookies).toEqual([]);
  // 30-day sessions refresh once a day (session.updateAge): make this one two days old.
  await writer()
    .update(authSession)
    .set({ expiresAt: new Date(Date.now() + 28 * 86_400_000) })
    .where(eq(authSession.userId, mira.userId));
  const refreshed = await currentSession(cookies);
  expect(refreshed?.setCookies.some((cookie) => cookie.includes('session_token='))).toBe(true);
});

test('an admin counts as one only with two-factor on', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  const cookies = await signIn(andrew.email, andrew.password, firefoxMac);
  expect((await currentSession(cookies))?.view).toMatchObject({
    siteRole: 'user',
    twoFactorEnabled: false,
    ageDeclaredAt: expect.any(String),
  });
  await seedTwoFactor(andrew.userId);
  expect((await currentSession(cookies))?.view).toMatchObject({ siteRole: 'admin', twoFactorEnabled: true });
});

test('the admin bootstrap runs once', async () => {
  expect(await bootstrapAdmin({ name: 'andrew', email: 'andrew@example.test', password: 'twelve chars ok' })).toMatchObject({ ok: true });
  expect(await bootstrapAdmin({ name: 'ruth', email: 'ruth@example.test', password: 'twelve chars ok' })).toEqual({
    ok: false,
    reason: 'admin.exists',
  });
});

test('device names and masked addresses', () => {
  expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toEqual({
    browser: 'Chrome',
    os: 'Linux',
  });
  expect(describeDevice(null)).toEqual({ browser: null, os: null });
  expect(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:8d3:x');
});

test('a two-factor setup shows its key until confirmed, then the recovery codes once, and a later code shows nothing', async () => {
  const mira = await seedAccount('mira');
  const cookies = await signIn(mira.email, mira.password, firefoxMac);
  const api = (await auth()).api;
  const enabled = await api.enableTwoFactor({ body: { password: mira.password }, headers: cookies });
  if (enabled.method !== 'totp') throw new Error('expected a TOTP setup');
  const pending = await pendingTotp(mira.userId, mira.email);
  expect(pending?.uri).toMatch(/^otpauth:\/\/totp\/a\.peblish\.test:mira%40example\.test\?secret=[A-Z2-7]+&issuer=a\.peblish\.test/);
  expect(pending?.key).toMatch(/^[A-Z2-7]{32,}$/);

  const secret = Buffer.from(base32Decode(pending!.key)).toString();
  const now = Date.now();
  const confirmed = await confirmTotpSetup(mira.userId, cookies, totpCode(secret, now));
  expect(confirmed?.some((cookie) => cookie.includes('session_token'))).toBe(true);
  expect(await pendingTotp(mira.userId, mira.email)).toBeNull();
  expect(await takeRecoveryCodes(mira.userId)).toEqual(enabled.backupCodes);
  expect(await takeRecoveryCodes(mira.userId)).toBeNull();

  // Posting a valid code again, with the new session, changes nothing and reveals nothing.
  const session = new Headers({ cookie: (confirmed ?? []).map((value) => value.split(';')[0]).join('; ') });
  expect(await confirmTotpSetup(mira.userId, session, totpCode(secret, now + 30_000))).toBeNull();
  expect(await takeRecoveryCodes(mira.userId)).toBeNull();
});

function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  return Uint8Array.from(bits.match(/.{8}/g) ?? [], (byte) => parseInt(byte, 2));
}
