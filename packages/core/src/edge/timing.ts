// The figures the edge cache rests on, and what each one bounds (lane notes, "Round 4").
//
// What the application bounds. A public answer is decided by one consistent read taken after
// the image bytes are in hand (public.ts); its deadline clock B (web's monotonic clock) starts
// before that read. The read must end by B + PUBLIC_READ_MS or the answer is private. The
// application's own body stream must be handed to its server's socket by B + PUBLIC_BODY_MS, or
// the stream errors and the server destroys that socket (stream.ts). That is all the deadline
// bounds: a proxy in front of the application (Traefik) can take a small body whole at once and
// pass it on to Cloudflare later, at any pace.
//
// What the second send covers. A takedown committing at C after the read's snapshot is not seen
// by it, so B < C. Its first purge is let out after C, and its second ECHO_MS after the first
// succeeded, so after B + ECHO_MS. A fill of that answer that has completed at Cloudflare before
// the second send is removed by it (assumed: a purge removes a fill completed before it). So the
// second send covers fills that complete within ECHO_MS of the decision; it does not cover a
// fill still arriving then.
//
// What bounds everything else: the edge time, s-maxage = 3600 s. A fill that completes after
// the second send (a delivery trickled through a proxy for longer than ECHO_MS, say) can be
// served until its hour is up. No fixed delay closes that: it needs an end-to-end completion
// bound the application does not control. The owner accepted it as a residual risk; the real-edge
// proof of 2026-11-13 saw such a fill stored and served after both purges.
//
// ECHO_MS is longer than PUBLIC_BODY_MS plus the longest Cloudflare was seen to hold a completely
// silent fill, so a delivery that goes silent ends before the second send. Cloudflare documents a
// 100 s read timeout (CLOUDFLARE_READ_TIMEOUT_MS); measured on 2026-11-13 (free plan, through
// Traefik, one run, which side closed not identified), the silent fill ended about 125 s after
// the decision (CLOUDFLARE_SILENT_FILL_MS). That helps only if Cloudflare abandons such a fill
// without storing it: seen once in that run, not guaranteed.
// Every time the purge path stores or compares in SQL is the database's.

/** Longest the public decision's read may take, from the deadline start to its answer, before the answer is private instead. */
export const PUBLIC_READ_MS = 2_000;
/** Longest from the deadline start until the last byte of a public answer is handed to the socket; past it the body is cut off. */
export const PUBLIC_BODY_MS = 10_000;
/** Each purge is sent again this long after its first send succeeded; it covers fills that complete within this long of the decision. */
export const ECHO_MS = 150_000;
/** Cloudflare's documented proxy read timeout (a 524 when the origin sends nothing for this long; not adjustable below Enterprise). */
export const CLOUDFLARE_READ_TIMEOUT_MS = 100_000;
/** How long after the decision a completely silent fill was seen to end on a real edge (2026-11-13, through Traefik, one run): longer than the documented timeout. */
export const CLOUDFLARE_SILENT_FILL_MS = 125_000;
/** Shortest gap between two Cloudflare requests across every worker: 4 a minute, under the free plan's 5. */
export const SEND_GAP_MS = 15_000;
/** How long a sender holds the batch it claimed; past it another worker may claim the rows. */
export const LEASE_MS = 30_000;
/** A readiness record older than this is stale: web answers private. */
export const READY_FRESH_MS = 5 * 60_000;
/** With nothing to purge, the worker proves the token this often (an idle check). */
export const CHECK_AFTER_MS = 2 * 60_000;
/** Debt due longer ago than this and still unpaid makes web answer private. */
export const DEBT_LATE_MS = 2 * 60_000;
/** An outbox event older than this that the edge purge consumer has not passed makes web answer private. */
export const CONSUMER_LATE_MS = 30_000;
/** Most first sends, and separately most second sends, owed and unclaimed; past it they collapse into one wide purge. */
export const MAX_OWED = 100;
/** The first wait after a failed request; it doubles with each failure in a row, up to `MAX_BACKOFF_MS`. */
export const FIRST_BACKOFF_MS = 20_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
/** A public answer whose Cache-Tag would hold more tags than this, or more bytes than `MAX_TAG_BYTES`, is private. */
export const MAX_TAGS = 64;
export const MAX_TAG_BYTES = 4_096;

/** An interval literal for SQL. */
export const interval = (ms: number) => `${ms} milliseconds`;
