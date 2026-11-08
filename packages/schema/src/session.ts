import { type } from 'arktype';
import { IsoDate, Uuid } from './ids.ts';

// Owned by lane A; filled from better-auth (c/identity/session.ts).
/** What the web app knows about the current request's signed-in user. */
export const SessionView = type({
  userId: Uuid,
  actorId: Uuid,
  name: 'string',
  displayName: 'string | null',
  /**
   * 'admin' only for auth_user.role 'admin' with two-factor turned on (A03: TOTP is
   * mandatory for admins); an admin without it acts as a user until it is on.
   */
  siteRole: "'user' | 'admin'",
  emailVerified: 'boolean',
  twoFactorEnabled: 'boolean',
  /** Neutral 16+ declaration time; null means not yet declared (NSFW stays hidden). */
  ageDeclaredAt: 'string.date.iso | null',
});
export type SessionView = typeof SessionView.infer;

/** One signed-in device on the security page. */
export const DeviceSession = type({
  id: Uuid,
  current: 'boolean',
  /** Browser and system read from the user agent, such as Firefox and macOS; null when unknown. */
  browser: 'string | null',
  os: 'string | null',
  /** The address with its last part hidden (203.0.113.x); null when none was recorded. */
  ip: 'string | null',
  createdAt: IsoDate,
  lastActiveAt: IsoDate,
});
export type DeviceSession = typeof DeviceSession.infer;
