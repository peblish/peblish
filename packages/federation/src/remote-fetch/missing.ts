import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { inboxRaw } from '@peblish/core/db/tables/federation';
import { readSetting } from '@peblish/core/settings/read';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Fetcher } from '../actors/document.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
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

type Memory = { attempts: number; nextAt: number; settled: boolean };
// What has been tried, per object, for this process: an object that will not come is asked for
// again later, not on every run, and one that cannot be had is not asked for again. A restart
// forgets it, which costs one more request per object still missing.
const memory = ((globalThis as { __peblishMissingFetches?: Map<string, Memory> }).__peblishMissingFetches ??= new Map());

/** Forgets what was tried (tests). */
export const forgetMissingAttempts = () => memory.clear();

const prefix = 'target.missing ';

export type MissingRun = { looked: number; stored: number };

/** One pass: fetches up to `remoteTtls.missing.perRun` of the objects skipped activities are waiting for. */
export async function fetchMissing(
  options: { fetch?: Fetcher; gapMs?: number; now?: number; signal?: AbortSignal } = {},
): Promise<MissingRun> {
  const run: MissingRun = { looked: 0, stored: 0 };
  if (!(await readSetting('inbox.enabled'))) return run;
  const now = options.now ?? Date.now();
  const { lookbackMs, perRun, retryAfterMs } = remoteTtls.missing;
  const fetch = polite(options.fetch ?? safeFetch, options.gapMs ?? remoteTtls.politeGapMs);
  const since = new Date(now - lookbackMs).toISOString();

  // The latest skipped activity for each missing object, with the community that announced it.
  const waiting = await db().execute<{ target: string; community: string | null; announce: string | null }>(sql`
    select distinct on (error) substr(error, ${prefix.length + 1}::int) as target, actor_ap_id as community, activity_id as announce
    from ${inboxRaw}
    where state = 'skipped' and error like ${`${prefix}%`} and received_at > ${since}::timestamptz
    order by error, received_at desc
    limit ${perRun * 8}`);

  for (const row of waiting) {
    if (run.looked >= perRun || options.signal?.aborted) break;
    const tried = memory.get(row.target);
    if (tried && (tried.settled || tried.nextAt > now)) continue;
    if (!URL.canParse(row.target) || new URL(row.target).protocol !== 'https:' || !row.community) continue;
    const [community] = await db()
      .select({ id: actors.id, apId: actors.apId })
      .from(actors)
      .where(and(eq(actors.apId, row.community), eq(actors.kind, 'Group'), eq(actors.local, false), isNull(actors.deletedAt)));
    if (!community) continue;
    // Stored since it was skipped (and its waiting rows requeued): nothing to fetch.
    if (await heldVouch(row.target)) {
      memory.set(row.target, { attempts: 0, nextAt: 0, settled: true });
      continue;
    }
    run.looked += 1;
    const outcome = await fetchRemoteObject(row.target, { vouch: { community, announceApId: row.announce ?? community.apId }, fetch });
    const attempts = (tried?.attempts ?? 0) + 1;
    if (outcome.status === 'unreachable') {
      const wait = retryAfterMs[Math.min(attempts, retryAfterMs.length) - 1] ?? 0;
      memory.set(row.target, { attempts, nextAt: now + wait, settled: false });
      continue;
    }
    // Stored, gone or refused: asking again changes nothing (a stored one whose waiting rows skip
    // again is waiting for something else).
    memory.set(row.target, { attempts, nextAt: 0, settled: true });
    if (outcome.status === 'stored' && outcome.created) run.stored += 1;
  }
  return run;
}
