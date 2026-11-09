import { isIPv4, isIPv6 } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import { writer } from '../db/write.ts';
import { throttles } from './tables.ts';

// A small limiter in Postgres, so every web process shares the counts. Each scope has a
// budget per client address and per identifier: at most `max` attempts in a fixed window
// of `seconds`, counted atomically per key. A refused attempt counts too, so hammering keeps
// the key refused until its window ends. Handlers that should count only failures (a wrong
// password) refund the attempt when it succeeds.

export type Budget = { max: number; seconds: number };

export type Scope =
  'sign-in' | 'password' | 'reset-mail' | 'invite-code' | 'verify-mail' | 'link-preview' | 'comment' | 'resolve' | 'report';

const minutes = (count: number) => count * 60;

/** The beta's budgets (deploy/README.md lists them). */
export const budgets: Record<Scope, { ip?: Budget; id?: Budget }> = {
  /** Signing in with a password, by address and by account; successes are refunded. */
  'sign-in': { ip: { max: 10, seconds: minutes(15) }, id: { max: 5, seconds: minutes(15) } },
  /** Signed in, typing the password again (change it, two-factor on or off, delete the account); successes are refunded. */
  password: { ip: { max: 10, seconds: minutes(15) }, id: { max: 5, seconds: minutes(15) } },
  /** Reset mail, every request, whether or not an account uses the address. */
  'reset-mail': { ip: { max: 10, seconds: minutes(60) }, id: { max: 3, seconds: minutes(60) } },
  /** Invite codes that match no invite (sign-up, the invite page); known codes are refunded. */
  'invite-code': { ip: { max: 10, seconds: minutes(60) } },
  /** Another email verification link for the same account. */
  'verify-mail': { id: { max: 1, seconds: 60 } },
  /** A link preview makes the server fetch an address a person chose, so it is counted per address and per account before the fetch. */
  'link-preview': { ip: { max: 30, seconds: minutes(10) }, id: { max: 20, seconds: minutes(10) } },
  /** A comment form post (reply, edit or delete), per account. */
  comment: { id: { max: 30, seconds: minutes(10) } },
  /** Looking up a remote handle or URL (lane DISC): one lookup is up to 12 fetches, so it is counted per address and per account before them. */
  resolve: { ip: { max: 20, seconds: minutes(10) }, id: { max: 10, seconds: minutes(10) } },
  /** A report form post (lane REP), per address and per account. */
  report: { ip: { max: 60, seconds: minutes(10) }, id: { max: 30, seconds: minutes(10) } },
};

/** An address as its key: IPv4 as is (also when mapped into IPv6), IPv6 by its /64, one subscriber's block. */
export function addressKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped && isIPv4(mapped)) return mapped;
  if (!isIPv6(ip)) return ip;
  const [head = '', tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/** One counted attempt: allowed when every key was within its budget; refund() takes it back. */
export type Attempt = { allowed: boolean; refund(): Promise<void> };

/**
 * Counts one attempt in `scope` against the client address and the identifier, each when
 * given and when the scope has a budget for it. Identifiers are compared trimmed and in
 * lower case.
 */
export async function attempt(scope: Scope, keys: { ip?: string | null; id?: string | null }): Promise<Attempt> {
  const counted: { key: string; windowStart: Date }[] = [];
  let allowed = true;
  for (const kind of ['ip', 'id'] as const) {
    const budget = budgets[scope][kind];
    const value = keys[kind]?.trim();
    if (!budget || !value) continue;
    const key = kind === 'ip' ? `ip:${addressKey(value)}` : `id:${value.toLowerCase()}`;
    // A new window once the stored one has run its length; otherwise one more in it. Windows
    // start on a whole millisecond, so refund() can name one by the Date it got back.
    const now = sql`date_trunc('milliseconds', now())`;
    const expired = sql`${throttles.windowStart} <= now() - make_interval(secs => ${budget.seconds})`;
    const [row] = await writer()
      .insert(throttles)
      .values({ scope, key, windowStart: now, count: 1 })
      .onConflictDoUpdate({
        target: [throttles.scope, throttles.key],
        set: {
          count: sql`case when ${expired} then 1 else ${throttles.count} + 1 end`,
          windowStart: sql`case when ${expired} then ${now} else ${throttles.windowStart} end`,
        },
      })
      .returning({ count: throttles.count, windowStart: throttles.windowStart });
    if (!row) throw new Error('throttle upsert returned nothing');
    counted.push({ key, windowStart: row.windowStart });
    if (row.count > budget.max) allowed = false;
  }
  return {
    allowed,
    async refund() {
      for (const { key, windowStart } of counted)
        await writer()
          .update(throttles)
          .set({ count: sql`greatest(${throttles.count} - 1, 0)` })
          .where(and(eq(throttles.scope, scope), eq(throttles.key, key), eq(throttles.windowStart, windowStart)));
    },
  };
}
