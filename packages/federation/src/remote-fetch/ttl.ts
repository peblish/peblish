import { moderatorsTtlMs } from '@peblish/core/remote/moderators';
import { actorMaxAgeMs } from '../actors/resolve.ts';
import { nodeInfoMaxAgeMs, nodeInfoRetryMs } from '../nodeinfo/client.ts';
import { keyRefetchAfterMs } from '../signing/inbound.ts';

// How long what we fetched from peers is trusted, in one place. The first five are the figures
// the code that applies them already holds (each is imported, not copied, so this table cannot
// drift from the behaviour); the rest are the remote-fetch lane's own.

export const remoteTtls = {
  /** A stored remote actor older than this is fetched again, document and key, the next time something resolves it. */
  actorMs: actorMaxAgeMs,
  /** An actor is fetched for a key that does not verify at most this often (a rotated key is found once, not on every bad signature). */
  keyRefetchMs: keyRefetchAfterMs,
  /** An instance's NodeInfo software is read again after this, and a failed read is not repeated for `nodeInfoRetryMs`. */
  nodeInfoMs: nodeInfoMaxAgeMs,
  nodeInfoRetryMs,
  /** A mirrored moderator keeps its authority this long after the collection last listed it. */
  moderatorsMs: moderatorsTtlMs,
  /** Requests to one host leave at least this far apart, and never two at once (remote-fetch/polite.ts). */
  politeGapMs: 300,
  /** The missing-object fetch: what is looked for, and how often an object that will not come is asked for again. */
  missing: {
    /** Only activities skipped this recently are looked at; older ones are given up on. */
    lookbackMs: 7 * 24 * 60 * 60 * 1000,
    /** Objects fetched per run of the job. */
    perRun: 25,
    /** Waits after the first, second, ... failed attempt on one object (a peer that is down); the last wait repeats. */
    retryAfterMs: [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000, 24 * 60 * 60_000] as readonly number[],
    /** Waiting activities looked at in one page of the query, and pages read in one run (older ones wait for the next). */
    pageSize: 200,
    maxPages: 10,
    /** What the job remembers per (community, object) is kept this long once it is settled, and at most this many entries are kept. */
    settledForMs: 24 * 60 * 60 * 1000,
    memoryCap: 5000,
  },
} as const;
