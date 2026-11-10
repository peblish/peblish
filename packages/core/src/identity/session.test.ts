import { symmetricDecrypt } from 'better-auth/crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { currentPrincipal } from '../authz/principal.ts';
import { siteBans } from '../bans/tables.ts';
import { db } from '../db/read.ts';
import { authSession, authTwoFactor } from '../db/tables/auth.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedAccount, seedLocalInstance, seedTwoFactor, totpCode } from '../testing/seed-a.ts';
import { auth } from './auth.ts';
import { bootstrapAdmin } from './bootstrap.ts';
import { currentSession, describeDevice, deviceSessions, maskIp, revokeSession } from './session.ts';
import { changePasswordAs, confirmTotpSetup, pendingTotp, startTotpSetup, takeRecoveryCodes } from './two-factor.ts';

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

/** Signs in through the two-factor challenge with a TOTP code; the new session's cookie. */
async function signInWithCode(email: string, password: string, code: string): Promise<Headers> {
  const challenge = await signIn(email, password, firefoxMac);
  const { headers } = await (await auth()).api.verifyTOTP({ body: { code }, headers: challenge, returnHeaders: true });
  return cookiesOf(headers);
}

const cookiesOf = (headers: Headers) =>
  new Headers({
    cookie: headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  });

test('an admin counts as one only with two-factor on, in a session that passed it (B07 A1)', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  const password = await signIn(andrew.email, andrew.password, firefoxMac);
  expect((await currentSession(password))?.view).toMatchObject({
    siteRole: 'user',
    twoFactorEnabled: false,
    ageDeclaredAt: expect.any(String),
  });
  const { secret } = await seedTwoFactor(andrew.userId);
  // The account turned two-factor on; the password-only session did not pass it.
  expect((await currentSession(password))?.view).toMatchObject({ siteRole: 'user', twoFactorEnabled: true });
  const passed = await signInWithCode(andrew.email, andrew.password, totpCode(secret));
  const admin = await currentSession(passed);
  expect(admin?.view.siteRole).toBe('admin');

  // The recheck never raises a principal to admin: the password-only session's stays a user.
  const actorId = admin!.view.actorId;
  expect(await currentPrincipal(writer(), { kind: 'local', actorId, siteRole: 'user' })).toEqual({
    ok: true,
    principal: { kind: 'local', actorId, siteRole: 'user' },
  });

  // A password change replaces the session and keeps its mark.
  const changed = await changePasswordAs(admin!.sessionId, passed, { current: andrew.password, next: 'a new twelve char password' });
  expect((await currentSession(cookiesOf(new Headers(changed.map((cookie) => ['set-cookie', cookie])))))?.view.siteRole).toBe('admin');
});

test('a site-banned admin account has no admin authority (B07 A3)', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  const { secret } = await seedTwoFactor(andrew.userId);
  const passed = await signInWithCode(andrew.email, andrew.password, totpCode(secret));
  expect((await currentSession(passed))?.view.siteRole).toBe('admin');
  await writer().insert(siteBans).values({ actorId: andrew.actorId, source: 'local' });
  expect((await currentSession(passed))?.view.siteRole).toBe('user');
});

test('confirming a TOTP setup signs every other session out (B07 A1)', async () => {
  const andrew = await seedAccount('andrew', { role: 'admin' });
  const laptop = await signIn(andrew.email, andrew.password, firefoxMac);
  const phone = await signIn(andrew.email, andrew.password, safariPhone);
  const laptopId = (await currentSession(laptop))!.sessionId;
  await startTotpSetup(laptopId, andrew.userId, laptop, andrew.password);
  const secret = Buffer.from(base32Decode((await pendingTotp(andrew.userId, laptopId, andrew.email))!.key)).toString();
  const confirmed = await confirmTotpSetup(andrew.userId, laptopId, laptop, totpCode(secret));
  const enrolled = await currentSession(cookiesOf(new Headers((confirmed ?? []).map((cookie) => ['set-cookie', cookie]))));
  expect(enrolled?.view.siteRole).toBe('admin');
  expect(await currentSession(phone)).toBeNull();
  expect((await deviceSessions(andrew.userId, enrolled!.sessionId)).map(({ id }) => id)).toEqual([enrolled!.sessionId]);
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
  const sessionId = (await currentSession(cookies))!.sessionId;
  await startTotpSetup(sessionId, mira.userId, cookies, mira.password);
  const pending = await pendingTotp(mira.userId, sessionId, mira.email);
  expect(pending?.uri).toMatch(/^otpauth:\/\/totp\/a\.peblish\.test:mira%40example\.test\?secret=[A-Z2-7]+&issuer=a\.peblish\.test/);
  expect(pending?.key).toMatch(/^[A-Z2-7]{32,}$/);

  const secret = Buffer.from(base32Decode(pending!.key)).toString();
  const now = Date.now();
  const confirmed = await confirmTotpSetup(mira.userId, sessionId, cookies, totpCode(secret, now));
  expect(confirmed?.some((cookie) => cookie.includes('session_token'))).toBe(true);
  const session = new Headers({ cookie: (confirmed ?? []).map((value) => value.split(';')[0]).join('; ') });
  const replacement = (await currentSession(session))!.sessionId;
  expect(await pendingTotp(mira.userId, replacement, mira.email)).toBeNull();
  expect(await takeRecoveryCodes(mira.userId, replacement)).toHaveLength(10);
  expect(await takeRecoveryCodes(mira.userId, replacement)).toBeNull();

  // Posting a valid code again, with the new session, changes nothing and reveals nothing.
  expect(await confirmTotpSetup(mira.userId, replacement, session, totpCode(secret, now + 30_000))).toBeNull();
  expect(await takeRecoveryCodes(mira.userId, replacement)).toBeNull();
});

test('another session of the account sees neither the setup key nor the recovery codes, and cannot confirm (B07 A2)', async () => {
  const mira = await seedAccount('mira');
  const laptop = await signIn(mira.email, mira.password, firefoxMac);
  const phone = await signIn(mira.email, mira.password, safariPhone);
  const [laptopId, phoneId] = [(await currentSession(laptop))!.sessionId, (await currentSession(phone))!.sessionId];
  await startTotpSetup(laptopId, mira.userId, laptop, mira.password);
  expect(await pendingTotp(mira.userId, phoneId, mira.email)).toBeNull();
  const secret = Buffer.from(base32Decode((await pendingTotp(mira.userId, laptopId, mira.email))!.key)).toString();
  const now = Date.now();
  expect(await confirmTotpSetup(mira.userId, phoneId, phone, totpCode(secret, now))).toBeNull();

  const confirmed = await confirmTotpSetup(mira.userId, laptopId, laptop, totpCode(secret, now));
  const replacement = (await currentSession(cookiesOf(new Headers((confirmed ?? []).map((cookie) => ['set-cookie', cookie])))))!;
  // The reveal moved to the replacement session: the one that confirmed no longer exists, the phone was signed out.
  expect(await takeRecoveryCodes(mira.userId, laptopId)).toBeNull();
  expect(await takeRecoveryCodes(mira.userId, phoneId)).toBeNull();
  expect(await takeRecoveryCodes(mira.userId, replacement.sessionId)).toHaveLength(10);
});

test('a restart by another session never shows the earlier owner its new key, even before the new owner is recorded (review 2 AN2)', async () => {
  const mira = await seedAccount('mira');
  const laptop = await signIn(mira.email, mira.password, firefoxMac);
  const phone = await signIn(mira.email, mira.password, safariPhone);
  const [laptopId, phoneId] = [(await currentSession(laptop))!.sessionId, (await currentSession(phone))!.sessionId];
  await startTotpSetup(phoneId, mira.userId, phone, mira.password);
  const phoneKey = (await pendingTotp(mira.userId, phoneId, mira.email))!.key;

  // Hold the phone's ownership record: the laptop's restart commits its new secret, then waits
  // to replace that record. The phone looks in exactly that window.
  let held!: () => void;
  let release!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const holder = writer().transaction(async (t) => {
    await t.execute(sql`select 1 from auth_verification where identifier like ${`peblish-totp-setup:${mira.userId}%`} for update`);
    held();
    await released;
  });
  await holding;
  const restart = startTotpSetup(laptopId, mira.userId, laptop, mira.password);
  await waitsOnTheLock();

  const laptopSecret = await currentSecret(mira.userId);
  expect(Buffer.from(base32Decode(phoneKey)).toString()).not.toBe(laptopSecret);
  expect(await pendingTotp(mira.userId, phoneId, mira.email)).toBeNull();
  expect(await confirmTotpSetup(mira.userId, phoneId, phone, totpCode(laptopSecret))).toBeNull();

  release();
  await holder;
  await restart;
  expect(Buffer.from(base32Decode((await pendingTotp(mira.userId, laptopId, mira.email))!.key)).toString()).toBe(laptopSecret);
  expect(await pendingTotp(mira.userId, phoneId, mira.email)).toBeNull();
});

/** The account's two-factor secret as stored now (test code reads it to make codes). */
async function currentSecret(userId: string): Promise<string> {
  const [row] = await writer().select({ secret: authTwoFactor.secret }).from(authTwoFactor).where(eq(authTwoFactor.userId, userId));
  return symmetricDecrypt({ key: (await (await auth()).$context).secretConfig, data: row!.secret });
}

/** Resolves once a statement on auth_verification in this database waits on a lock. */
async function waitsOnTheLock(): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    const [row] = await db().execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query like '%auth_verification%'`,
    );
    if ((row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nothing waited on the held ownership record');
}

function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  return Uint8Array.from(bits.match(/.{8}/g) ?? [], (byte) => parseInt(byte, 2));
}
