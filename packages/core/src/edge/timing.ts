// The figures the edge cache's safety rests on (lane notes, "Round 2", for the argument).
//
// A public answer is decided by one consistent read taken after the image bytes are in hand
// (public.ts). It is sent only if that read finished within PUBLIC_DEADLINE_MS of the moment it
// began; otherwise the answer is private. A takedown that commits after the read began is not
// seen by it, so such an answer can reach Cloudflare after the takedown's first purge: it left
// the origin by (read start + PUBLIC_DEADLINE_MS) < (commit + PUBLIC_DEADLINE_MS), and every
// purge is sent a second time ECHO_MS after its first send succeeded, which is after the commit.
// The second send therefore removes it as long as the body reaches Cloudflare within
// ECHO_MS - PUBLIC_DEADLINE_MS (58 s) of leaving: a 10 MiB image at 1.5 Mbit/s or faster.

/** Longest a public decision's read may take, from its start to its answer, before the answer is private instead. */
export const PUBLIC_DEADLINE_MS = 2_000;
/** Each purge is sent again this long after its first send succeeded. */
export const ECHO_MS = 60_000;
/** Shortest gap between two Cloudflare requests across every worker: 4 a minute, under the free plan's 5. */
export const SEND_GAP_MS = 15_000;
/** How long a sender holds the rows it claimed; past it another worker may send them. */
export const LEASE_MS = 30_000;
/** A readiness record older than this is stale: web answers private. */
export const READY_FRESH_MS = 5 * 60_000;
/** With nothing to purge, the worker proves the token works this often (an idle check). */
export const CHECK_AFTER_MS = 2 * 60_000;
/** Debt due longer ago than this and still unpaid makes web answer private. */
export const DEBT_LATE_MS = 2 * 60_000;
/** Most rows owed and unclaimed; past it they collapse into one wide purge. */
export const MAX_OWED = 100;
/** The first wait after a failed request; it doubles with each failure in a row, up to `MAX_BACKOFF_MS`. */
export const FIRST_BACKOFF_MS = 20_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
