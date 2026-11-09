import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { inboxRaw } from '@peblish/core/db/tables/federation';
import { readSetting } from '@peblish/core/settings/read';
import { sql } from 'drizzle-orm';
import type { Fetcher } from '../actors/document.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import { localOrigin } from '../federation.ts';
import { requeueSkippedFor } from '../inbound/queue.ts';
import { fetchRemoteObject, heldVouch } from './object.ts';
import { polite } from './polite.ts';
import { remoteTtls } from './ttl.ts';

// The inbound pipeline skips a vote, an edit or a moderator's action about an object we never
// saw with `target.missing <ap_id>` and waits for the object to arrive (inbound/queue.ts). It
// never fetches the object itself. This does: it finds those targets, fetches each from its own
// origin and stores it, and storing it puts the waiting activities back in line.
//
// What vouches for an object is the community whose Announce carried the skipped activity: it
// announced a vote on this object, so the object is in its community. An activity that did not
// arrive in a remote community's Announce vouches for nothing and is left alone.

type Memory = { attempts: number; nextAt: number; settled: boolean; expires: number };
// What has been tried, per community and object, for this process: an object that will not
// come is asked for again later, not on every run, and one that cannot be had is not asked for
// again until the entry expires. The community is part of the key because the answer depends
// on it (the vouch): one community's refusal of an object says nothing about another's, so a
// community cannot get an object it does not vouch for marked as settled for everyone. The map
// holds at most `memoryCap` entries (the oldest go first) and an entry expires, so a flood of
// targets cannot grow it and nothing is given up on for ever. A restart forgets it, which costs
// one more request per object still missing.
const memory = ((globalThis as { __peblishMissingFetches?: Map<string, Memory> }).__peblishMissingFetches ??= new Map());

/** Forgets what was tried, and says how many entries are held (tests). */
export const forgetMissingAttempts = () => memory.clear();
export const missingAttemptCount = () => memory.size;

const keyOf = (community: string, target: string) => `${community}\n${target}`;

function recall(key: string, now: number): Memory | undefined {
  const found = memory.get(key);
  if (found && found.expires <= now) {
    memory.delete(key);
    return undefined;
  }
  return found;
}

function remember(key: string, entry: Omit<Memory, 'expires'>, now: number) {
  const { retryAfterMs, settledForMs, memoryCap } = remoteTtls.missing;
  // A settled entry lives a day; one waiting to be tried again lives until a day past its next try.
  const expires = entry.settled ? now + settledForMs : entry.nextAt + (retryAfterMs.at(-1) ?? settledForMs);
  memory.delete(key);
  memory.set(key, { ...entry, expires });
  for (const oldest of memory.keys()) {
    if (memory.size <= memoryCap) break;
    memory.delete(oldest);
  }
}

const prefix = 'target.missing ';

export type MissingRun = { looked: number; stored: number };

type Waiting = { target: string; communityId: string; community: string; announce: string | null; receivedAt: string };

/** One pass: fetches up to `remoteTtls.missing.perRun` of the objects skipped activities are waiting for. */
export async function fetchMissing(
  options: { fetch?: Fetcher; gapMs?: number; now?: number; signal?: AbortSignal } = {},
): Promise<MissingRun> {
  const run: MissingRun = { looked: 0, stored: 0 };
  if (!(await readSetting('inbox.enabled'))) return run;
  const now = options.now ?? Date.now();
  const { lookbackMs, perRun, pageSize, maxPages } = remoteTtls.missing;
  const fetch = polite(options.fetch ?? safeFetch, options.gapMs ?? remoteTtls.politeGapMs);
  const since = new Date(now - lookbackMs).toISOString();
  const here = await localOrigin();
  // The latest skipped activity for each missing object and each community that announced it, newest
  // first, a page at a time: objects this process will not ask for now (settled, backed off, our
  // own) are passed over, so a crowd of newer ones that cannot be fetched never keeps an older one
  // that can from being reached. `cursor` is the last row of the previous page.
  let cursor: { receivedAt: string; target: string; community: string } | null = null;
  for (let page = 0; page < maxPages && run.looked < perRun && !options.signal?.aborted; page++) {
    const after = cursor
      ? sql`where (received_at, target, community) < (${cursor.receivedAt}::timestamptz, ${cursor.target}, ${cursor.community})`
      : sql``;
    const waiting: Waiting[] = await db().execute<Waiting>(sql`
      select target, "communityId", community, announce, received_at::text as "receivedAt" from (
        select distinct on (r.error, r.actor_ap_id)
          substr(r.error, ${prefix.length + 1}::int) as target, a.id as "communityId", r.actor_ap_id as community,
          r.activity_id as announce, r.received_at
        from ${inboxRaw} r
        join ${actors} a on a.ap_id = r.actor_ap_id and a.kind = 'Group' and not a.local and a.deleted_at is null
        where r.state = 'skipped' and r.error like ${`${prefix}%`} and r.received_at > ${since}::timestamptz
        order by r.error, r.actor_ap_id, r.received_at desc
      ) latest
      ${after}
      order by received_at desc, target desc, community desc
      limit ${pageSize}`);
    const last = waiting.at(-1);
    if (!last) break;
    cursor = { receivedAt: last.receivedAt, target: last.target, community: last.community };

    for (const row of waiting) {
      if (run.looked >= perRun || options.signal?.aborted) break;
      if (!URL.canParse(row.target) || new URL(row.target).protocol !== 'https:') continue;
      const key = keyOf(row.community, row.target);
      const tried = recall(key, now);
      if (tried && (tried.settled || tried.nextAt > now)) continue;
      // We never fetch ourselves (an object of ours that is missing is gone).
      if (new URL(row.target).origin === here) {
        remember(key, { attempts: 0, nextAt: 0, settled: true }, now);
        continue;
      }
      // Stored since it was skipped: nothing to fetch, but the rows that waited for it may still wait (a
      // store that was cut off before it put them back in line), so put them back now, once.
      if (await heldVouch(row.target)) {
        await requeueSkippedFor(row.target);
        remember(key, { attempts: 0, nextAt: 0, settled: true }, now);
        continue;
      }
      run.looked += 1;
      const community = { id: row.communityId, apId: row.community };
      const outcome = await fetchRemoteObject(row.target, { vouch: { community, announceApId: row.announce ?? row.community }, fetch });
      const attempts = (tried?.attempts ?? 0) + 1;
      if (outcome.status === 'unreachable') {
        const wait = remoteTtls.missing.retryAfterMs[Math.min(attempts, remoteTtls.missing.retryAfterMs.length) - 1] ?? 0;
        remember(key, { attempts, nextAt: now + wait, settled: false }, now);
        continue;
      }
      // Stored, gone or refused: asking again changes nothing (a stored one whose waiting rows skip
      // again is waiting for something else).
      remember(key, { attempts, nextAt: 0, settled: true }, now);
      if (outcome.status === 'stored' && outcome.created) run.stored += 1;
    }
    if (waiting.length < pageSize) break;
  }
  return run;
}
