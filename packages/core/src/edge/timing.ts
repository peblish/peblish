// The figures the edge cache's safety rests on (lane notes, "Round 3", for the argument in full).
//
// A public answer is decided by one consistent read taken after the image bytes are in hand
// (public.ts). The deadline clock starts before that read begins. The read must finish within
// PUBLIC_READ_MS, and the whole body must be handed to the socket within PUBLIC_BODY_MS of the
// same start, or the body stream is errored and the server destroys the socket, so the edge gets
// a truncated answer (shorter than its content-length) that it cannot store (stream.ts).
//
// A takedown that commits at C after the read's snapshot is not seen by it. That answer's last
// byte was handed to the socket before C + PUBLIC_BODY_MS. Every purge is sent twice; the
// second send is let out ECHO_MS after the first succeeded, and the first is after C, so the
// second send leaves after C + ECHO_MS = C + PUBLIC_BODY_MS + 110 s. The 110 s margin covers the
// last bytes crossing to Cloudflare and Cloudflare finishing the fill, which is then visible to
// the second purge. It is longer than CLOUDFLARE_READ_TIMEOUT_MS, so a link that stalls with the
// last bytes in the socket buffer either delivers them before the second send or is cut off by
// Cloudflare (which then stores nothing) before it.
//
// Assumed of Cloudflare, to be proven on a real edge: it does not store an answer whose body ends
// before its content-length; a purge sent after a fill has completed removes that fill; and it
// gives up on an origin that sends nothing for CLOUDFLARE_READ_TIMEOUT_MS. Every time below is
// the database's, so web and every worker share one clock.

/** Longest the public decision's read may take, from the deadline start to its answer, before the answer is private instead. */
export const PUBLIC_READ_MS = 2_000;
/** Longest from the deadline start until the last byte of a public answer is handed to the socket; past it the body is cut off. */
export const PUBLIC_BODY_MS = 10_000;
/** Each purge is sent again this long after its first send succeeded: past the body deadline by more than Cloudflare's read timeout. */
export const ECHO_MS = 120_000;
/** Cloudflare's proxy read timeout (a 524 when the origin sends nothing for this long; not adjustable below Enterprise). */
export const CLOUDFLARE_READ_TIMEOUT_MS = 100_000;
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
