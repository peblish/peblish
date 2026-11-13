import type { EdgeConfig } from './config.ts';
import { MAX_TAGS_PER_PURGE, purgeTags, type HttpFetch } from './cloudflare.ts';
import type { Purge } from './tags.ts';

// The purges the worker owes Cloudflare, held in the worker's memory between the outbox
// consumer that finds them (consumer.ts) and the job that sends them (job.ts), so no network call
// runs inside the consumer's transaction. Memory is enough because a new queue starts with a
// wide purge owed: whatever a crashed or restarted worker had not sent yet is covered by
// purging every public proxy answer when its successor starts. Purging twice is harmless, so
// a batch that rolls back and is handled again only adds tags that are already owed.

/**
 * A wide purge is sent again this long after it succeeded. The proxy decides a public answer
 * before it fetches the image (a queued request can wait its turn and then fetch for up to 15 s),
 * so an answer decided just before a peer was quarantined or the kill switch turned off could
 * reach the edge after the first purge; the second one, a minute later, removes it. Content
 * takedowns need no echo: the proxy asks about the content again after the fetch.
 */
export const WIDE_ECHO_MS = 60_000;

/** The first wait after a failed purge; it doubles with each failure in a row, up to `maxBackoffMs`. */
const firstBackoffMs = 20_000;
const maxBackoffMs = 5 * 60_000;

export type FlushDeps = { fetch?: HttpFetch; now?: () => number };

export type PurgeQueue = {
  /** Owes this purge too. */
  add(purge: Purge): void;
  /** What is owed: the wide purge, or these tags (none when nothing is). */
  owed(): Purge;
  /**
   * Sends what is owed in one request: the tags, or the wide purge when one is owed or more than
   * Cloudflare takes at once are waiting, and each wide purge once more `WIDE_ECHO_MS` after it. On success those are settled (anything added meanwhile
   * stays owed); on failure everything stays owed and the next flush waits out a backoff, or a
   * 429's Retry-After. A failure is logged the first time and at each doubling of the run of
   * failures (1, 2, 4, 8 ...), and the first success after it says so, so a purge that keeps
   * failing stays visible without a line every run. Returns whether a request succeeded.
   */
  flush(config: EdgeConfig, deps?: FlushDeps): Promise<boolean>;
};

export function createPurgeQueue({ wide = true }: { wide?: boolean } = {}): PurgeQueue {
  let all = wide;
  const tags = new Set<string>();
  let failures = 0;
  let notBefore = 0;
  /** When the last wide purge is to be sent again; null when no echo is due. */
  let echoAt: number | null = null;
  let echoing = false;

  const owed = (): Purge => (all || tags.size > MAX_TAGS_PER_PURGE ? 'all' : [...tags]);

  return {
    add(purge) {
      if (purge === 'all') all = true;
      else for (const tag of purge) tags.add(tag);
    },
    owed,
    async flush(config, { fetch, now = Date.now } = {}) {
      if (echoAt !== null && now() >= echoAt && !all) {
        all = echoing = true;
        echoAt = null;
      }
      const purge = owed();
      if (purge !== 'all' && purge.length === 0) return false;
      if (now() < notBefore) return false;
      const result = await purgeTags(config, purge, { fetch });
      if (result.ok) {
        if (purge === 'all') {
          all = false;
          tags.clear();
          echoAt = echoing ? null : now() + WIDE_ECHO_MS;
          echoing = false;
        } else for (const tag of purge) tags.delete(tag);
        if (failures > 0) console.log(`edge cache: purge succeeded after ${failures} failed attempts`);
        failures = 0;
        notBefore = 0;
        return true;
      }
      failures += 1;
      const backoff = Math.min(firstBackoffMs * 2 ** Math.min(failures - 1, 10), maxBackoffMs);
      const wait = Math.max(backoff, result.retryAfterMs ?? 0);
      notBefore = now() + wait;
      if ((failures & (failures - 1)) === 0) {
        const waiting = purge === 'all' ? 'a purge of every remote image' : `${purge.length} tags`;
        console.error(
          `edge cache: purge failed ${failures} time${failures === 1 ? '' : 's'} in a row (${result.why}); ${waiting} still owed, next try in ${Math.round(wait / 1000)} s`,
        );
      }
      return false;
    },
  };
}

const key = Symbol.for('peblish.edge.purgeQueue');
const holder = globalThis as { [key]?: PurgeQueue };

/** This process's queue (on globalThis, so a build that carries two copies of this module shares one). */
export function purgeQueue(): PurgeQueue {
  return (holder[key] ??= createPurgeQueue());
}

/** Replaces this process's queue (tests start from an empty one). */
export function setPurgeQueue(queue: PurgeQueue): void {
  holder[key] = queue;
}
