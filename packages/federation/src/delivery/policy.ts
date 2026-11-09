// How a delivery attempt ends, as data and one pure function (carry-forward finding 11: the
// schedule is stored as data, and its total is stated). The spike's schedule, kept: every retry
// waits three times as long as the one before, up to six hours.

/** Attempts a delivery gets: the first, and nine retries. */
export const maxAttempts = 10;

/** The wait before retry n (index 0 is the wait after the first attempt fails): 10 s, 30 s, 90 s ... capped at 6 h. */
export const retryDelaysMs = [10_000, 30_000, 90_000, 270_000, 810_000, 2_430_000, 7_290_000, 21_600_000, 21_600_000] as const;

/** From the first failure to the last attempt: 54,130 s, about 15 hours. A peer down longer misses the activity. */
export const retryWindowMs = retryDelaysMs.reduce((total, delay) => total + delay, 0);

/** The longest a peer's Retry-After may push a retry. */
export const retryAfterCapMs = 21_600_000;

/** One POST's limits: it times out, its answer is read up to a cap, and a worker's claim outlives the timeout. */
export const requestTimeoutMs = 15_000;
export const maxResponseBytes = 64 * 1024;
export const leaseMs = 60_000;

/**
 * The only 4xx worth another try: a peer that is slow (408) or too busy (429). Every other 4xx,
 * 401 and 425 included, says the activity itself was refused (400, 401, 403, 404, 405, 410, 413,
 * 422 and the rest), so asking again cannot help; the same goes for PieFed's day-one cap on a
 * new remote account's posts. Signing again does not change a 401 either, since we never send a
 * second scheme.
 */
const retryableClientErrors = new Set([408, 429]);

export type Attempt =
  | { status: number; retryAfterMs: number | null }
  /** A request that never got an answer. `permanent` is a refused destination (BlockedDestinationError). */
  | { error: string; permanent: boolean };

export type Verdict = { state: 'delivered' } | { state: 'failed' } | { state: 'pending'; delayMs: number };

/** What becomes of a delivery whose attempt number `attempts` (counting this one) came out as `attempt`. */
export function verdict(attempts: number, attempt: Attempt): Verdict {
  if ('error' in attempt) return attempt.permanent ? { state: 'failed' } : retry(attempts, null);
  const { status } = attempt;
  if (status >= 200 && status < 300) return { state: 'delivered' };
  // A redirect is never followed, so it is an answer we cannot use.
  if (status >= 300 && status < 400) return { state: 'failed' };
  if (status >= 400 && status < 500 && !retryableClientErrors.has(status)) return { state: 'failed' };
  return retry(attempts, attempt.retryAfterMs);
}

function retry(attempts: number, retryAfterMs: number | null): Verdict {
  if (attempts >= maxAttempts) return { state: 'failed' };
  const scheduled = retryDelaysMs[Math.min(attempts - 1, retryDelaysMs.length - 1)]!;
  const asked = retryAfterMs === null ? 0 : Math.min(retryAfterMs, retryAfterCapMs);
  return { state: 'pending', delayMs: Math.max(scheduled, asked) };
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
