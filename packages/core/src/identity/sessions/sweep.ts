import { inArray, lt } from 'drizzle-orm';
import { authSession } from '../../db/tables/auth.ts';
import { writer } from '../../db/write.ts';

// Retention for sessions (B07 A5). better-auth refuses an expired session but deletes its row
// only when the browser sends that cookie again, so a browser that stops sending it leaves the
// token, address and user agent for ever. The privacy policy (content/legal/privacy.en.md,
// "Sessions and reset/verification secrets") says residual records go within 30 days of
// expiry; this sweep, run hourly by the job beside it, deletes them once expired. better-auth
// already deletes expired verification values on every lookup.

/** Rows deleted per statement, and statements per run (a larger backlog finishes on the next run). */
export const sessionSweep = { batch: 1000, maxBatches: 25 } as const;

/**
 * Deletes expired sessions, `batch` rows a statement, at most `maxBatches` statements; returns
 * how many went. Rows are claimed FOR UPDATE SKIP LOCKED, so two workers sweeping at once take
 * different rows, and a session's two-factor mark goes with it (ON DELETE CASCADE).
 */
export async function sweepExpiredSessions(
  options: { now?: Date; batch?: number; maxBatches?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const { now = new Date(), batch = sessionSweep.batch, maxBatches = sessionSweep.maxBatches, signal } = options;
  let total = 0;
  for (let run = 0; run < maxBatches && !signal?.aborted; run++) {
    const db = writer();
    const expired = db
      .select({ id: authSession.id })
      .from(authSession)
      .where(lt(authSession.expiresAt, now))
      .limit(batch)
      .for('update', { skipLocked: true });
    const deleted = await db.delete(authSession).where(inArray(authSession.id, expired)).returning({ id: authSession.id });
    total += deleted.length;
    if (deleted.length < batch) break;
  }
  return total;
}
