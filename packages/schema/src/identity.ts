import { type } from 'arktype';

// Owned by lane A: the sign-up rules shared by core (which enforces them) and web (which
// explains them). Form bodies arrive as strings; the specific checks below give each problem
// its own code instead of one "invalid form".

/** better-auth enforces the same bounds on reset and change (c/identity/auth.ts). */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** The youngest age that may hold an account (decision, 2026-11-08). */
export const MINIMUM_AGE = 16;

/** Names a new account may not take: they read as the instance or its staff. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'abuse',
  'admin',
  'administrator',
  'announcements',
  'feddit',
  'help',
  'mod',
  'moderator',
  'moderators',
  'noreply',
  'official',
  'peblish',
  'postmaster',
  'root',
  'security',
  'staff',
  'support',
  'system',
  'webmaster',
]);

export const SignUpBody = type({
  invite: 'string',
  username: 'string',
  email: 'string',
  password: 'string',
  day: 'string',
  month: 'string',
  year: 'string',
  'terms?': 'string',
});
export type SignUpBody = typeof SignUpBody.infer;

export const Email = type('string.email');

export type DateOfBirth = { year: number; month: number; day: number };

/**
 * A real calendar date from the three form fields, not in the future and not before 1900, or
 * null. Only the age computed from it is used; the date itself is never stored.
 */
export function dateOfBirth(day: string, month: string, year: string, now = new Date()): DateOfBirth | null {
  const [d, m, y] = [day, month, year].map((part) => (/^\d{1,4}$/.test(part.trim()) ? Number(part.trim()) : Number.NaN));
  if (d === undefined || m === undefined || y === undefined || [d, m, y].some(Number.isNaN)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  if (!real || y < 1900 || date.getTime() > now.getTime()) return null;
  return { year: y, month: m, day: d };
}

/** Completed years between the date of birth and `now`, by the UTC calendar. */
export function ageOn(dob: DateOfBirth, now = new Date()): number {
  const birthdayPassed = now.getUTCMonth() + 1 > dob.month || (now.getUTCMonth() + 1 === dob.month && now.getUTCDate() >= dob.day);
  return now.getUTCFullYear() - dob.year - (birthdayPassed ? 0 : 1);
}
