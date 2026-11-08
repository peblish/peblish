import type { Uuid } from '@peblish/schema/ids';
import type { DeviceSession, SessionView } from '@peblish/schema/session';
import { and, desc, eq, gt } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { authSession, authUser } from '../db/tables/auth.ts';
import { auth } from './auth.ts';
import { ageDeclarations } from './tables.ts';

export type CurrentSession = {
  view: SessionView;
  sessionId: Uuid;
  email: string;
  /** auth_user.role, whatever two-factor says (the admin pages explain a missing second factor). */
  role: 'user' | 'admin';
  sessionCreatedAt: Date;
  /** Set-Cookie values better-auth wants sent back (a refreshed session cookie). */
  setCookies: string[];
};

/**
 * The signed-in person for a request's cookies, or null. A session whose actor is gone or
 * deleted counts as signed out (deletion removes the user, and with it every session).
 */
export async function currentSession(headers: Headers): Promise<CurrentSession | null> {
  const { headers: responseHeaders, response } = await (await auth()).api.getSession({ headers, returnHeaders: true });
  if (!response) return null;
  const [row] = await db()
    .select({
      actorId: actors.id,
      name: actors.name,
      displayName: actors.displayName,
      deletedAt: actors.deletedAt,
      role: authUser.role,
      email: authUser.email,
      emailVerified: authUser.emailVerified,
      twoFactorEnabled: authUser.twoFactorEnabled,
      declaredAt: ageDeclarations.declaredAt,
    })
    .from(actors)
    .innerJoin(authUser, eq(authUser.id, actors.userId))
    .leftJoin(ageDeclarations, eq(ageDeclarations.actorId, actors.id))
    .where(eq(actors.userId, response.user.id));
  if (!row || row.deletedAt) return null;
  const role = row.role === 'admin' ? 'admin' : 'user';
  const twoFactorEnabled = row.twoFactorEnabled === true;
  return {
    view: {
      userId: response.user.id,
      actorId: row.actorId,
      name: row.name,
      displayName: row.displayName,
      siteRole: role === 'admin' && twoFactorEnabled ? 'admin' : 'user',
      emailVerified: row.emailVerified,
      twoFactorEnabled,
      ageDeclaredAt: row.declaredAt?.toISOString() ?? null,
    },
    sessionId: response.session.id,
    email: row.email,
    role,
    sessionCreatedAt: response.session.createdAt,
    setCookies: responseHeaders.getSetCookie(),
  };
}

/** Browser and system from a user agent, coarse on purpose ("Firefox", "macOS"). */
export function describeDevice(userAgent: string | null): { browser: string | null; os: string | null } {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrom(e|ium)\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  return { browser, os };
}

/** 203.0.113.7 as 203.0.113.x; IPv6 keeps its first four groups. */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.replace(/\.\d+$/, '.x');
  const groups = ip.split(':');
  return groups.length > 4 ? `${groups.slice(0, 4).join(':')}:x` : ip;
}

/** The user's live sessions, most recently active first, for the security page. */
export async function deviceSessions(userId: Uuid, currentSessionId: Uuid): Promise<DeviceSession[]> {
  const rows = await db()
    .select({
      id: authSession.id,
      userAgent: authSession.userAgent,
      ipAddress: authSession.ipAddress,
      createdAt: authSession.createdAt,
      updatedAt: authSession.updatedAt,
    })
    .from(authSession)
    .where(and(eq(authSession.userId, userId), gt(authSession.expiresAt, new Date())))
    .orderBy(desc(authSession.updatedAt));
  return rows.map((row) => ({
    id: row.id,
    current: row.id === currentSessionId,
    ...describeDevice(row.userAgent),
    ip: maskIp(row.ipAddress),
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.updatedAt.toISOString(),
  }));
}

/** Signs one of the user's sessions out; false when it is not theirs or already gone. */
export async function revokeSession(userId: Uuid, sessionId: Uuid): Promise<boolean> {
  const [row] = await db()
    .select({ token: authSession.token })
    .from(authSession)
    .where(and(eq(authSession.id, sessionId), eq(authSession.userId, userId)));
  if (!row) return false;
  const context = await (await auth()).$context;
  await context.internalAdapter.deleteSession(row.token);
  return true;
}
