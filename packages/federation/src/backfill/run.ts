import { authorize } from '@peblish/core/authz/authorize';
import { systemPrincipal } from '@peblish/core/authz/system';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import {
  backfillLimits,
  claimBackfill,
  maxBackfillAttempts,
  settleBackfill,
  type BackfillLimits,
  type BackfillResult,
  type ClaimedBackfill,
} from '@peblish/core/remote/backfill';
import { eq } from 'drizzle-orm';
import { FetchFailure, type Fetcher } from '../actors/document.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import type { JsonObject } from '../mapping/json.ts';
import { refreshRemoteActor } from '../remote-fetch/actor.ts';
import { readCollection } from '../remote-fetch/collection.ts';
import { isTransient, readObject, storeObject, type ObjectOutcome, type Vouch } from '../remote-fetch/object.ts';
import { polite } from '../remote-fetch/polite.ts';
import { remoteTtls } from '../remote-fetch/ttl.ts';

// The backfill of a followed remote community. We joined late, so the community's earlier posts
// are unknown here and activities about them (a vote on a post from last month, an edit, a
// moderator's lock) were skipped with `target.missing`. This reads what the community offers:
//
// - its featured and outbox collections: Lemmy 0.19.21 and PieFed 1.8.11 serve both on the
//   community actor (`featured`, `outbox`; the corpus' `fetched/` group documents advertise
//   them). Lemmy's outbox is the Create activities of its last posts, its featured the pinned
//   Pages. Neither serves a collection of a post's comments: their Pages carry no `context` or
//   `replies` (corpus: every Lemmy and PieFed Page and Note), so no comments come from them;
//   a comment an activity names is fetched when it is wanted (remote-fetch/missing.ts).
// - FEP-7888: where a post does offer a `context` (or `replies`) collection, its comments.
//
// Each object is stored through the mutations the inbound handlers use, authorized as its
// author under the community's vouching (remote-fetch/object.ts), and every stored object
// puts back in line the activities that were skipped for want of it. Fetches go one at a time
// to a host, with a gap (remote-fetch/polite.ts), and a backfill makes at most
// `backfillLimits.requests` of them.

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const originOf = (url: string) => new URL(url).origin;

export type BackfillReport = { outcome: 'done' | 'failed' | 'retry'; posts: number; comments: number; note: string | null };

type Entry = { id: string; embedded: JsonObject | null };
const contentTypes = new Set(['Page', 'Article', 'Video', 'Note']);

/** What a collection item points at: the object in a Create or Announce, a bare object, or an IRI. */
function entryOf(item: unknown): Entry | null {
  if (typeof item === 'string') return URL.canParse(item) ? { id: item, embedded: null } : null;
  if (!isObject(item)) return null;
  if (item.type === 'Create' || item.type === 'Announce' || item.type === 'Update') return entryOf(item.object);
  if (typeof item.id === 'string' && typeof item.type === 'string' && contentTypes.has(item.type)) return { id: item.id, embedded: item };
  return null;
}

/** The collection a post offers its comments in: FEP-7888's `context`, else `replies`. Neither is a link to the post itself. */
function offeredCollection(post: unknown): unknown {
  if (!isObject(post)) return null;
  for (const key of ['context', 'replies']) {
    const value = post[key];
    if (typeof value === 'string' && value !== post.id && URL.canParse(value)) return value;
    if (isObject(value) && String(value.type).includes('Collection')) return value;
  }
  return null;
}

export type BackfillOptions = {
  fetch?: Fetcher;
  /** Aborted when the worker is stopping: the run ends where it is, to be taken up again (a retry). */
  signal?: AbortSignal;
  limits?: BackfillLimits;
  /** The gap between requests to one host; tests pass 0. */
  gapMs?: number;
};

/**
 * Runs one claimed backfill and says how it ended; the caller settles it. Never throws for a
 * peer's behaviour (down, slow, malformed): that is a retry, a failure or a note.
 */
export async function runBackfill(claimed: ClaimedBackfill, options: BackfillOptions = {}): Promise<BackfillReport> {
  const limits = options.limits ?? backfillLimits;
  const base = options.fetch ?? safeFetch;
  const budget = { used: 0, spent: false };
  const counted: Fetcher = (url, init) => {
    if (budget.used >= limits.requests) {
      budget.spent = true;
      return Promise.reject(new Error('the backfill request budget is spent'));
    }
    budget.used += 1;
    return base(url, init);
  };
  const fetch = polite(counted, options.gapMs ?? remoteTtls.politeGapMs);

  const standing = await refreshRemoteActor(claimed.apId, { fetch });
  if (standing === 'deleted') return { outcome: 'done', posts: 0, comments: 0, note: 'the community is gone (410 or a Tombstone)' };
  if (standing === 'unreachable') return { outcome: 'retry', posts: 0, comments: 0, note: 'the community could not be reached' };
  if (standing === 'refused') return { outcome: 'failed', posts: 0, comments: 0, note: 'the community document could not be read' };

  // The refresh may have changed where its collections are.
  const [community] = await db()
    .select({ id: actors.id, apId: actors.apId, outboxUrl: actors.outboxUrl, featuredUrl: actors.featuredUrl, deletedAt: actors.deletedAt })
    .from(actors)
    .where(eq(actors.id, claimed.communityId));
  if (!community || community.deletedAt) return { outcome: 'done', posts: 0, comments: 0, note: 'the community is gone' };
  if (!community.outboxUrl && !community.featuredUrl)
    return { outcome: 'done', posts: 0, comments: 0, note: 'the community serves no collections' };

  const notes: string[] = [];
  let posts = 0;
  let comments = 0;
  let unreachable = 0;
  const seen = new Set<string>();
  const vouch = (collectionUrl: string): Vouch => ({ community, announceApId: collectionUrl });

  /** An object's document: embedded when its own server is the community's, else read from where it lives. */
  async function load(entry: Entry, owner: string) {
    if (entry.embedded && originOf(entry.id) === originOf(owner)) return { json: entry.embedded as unknown };
    return readObject(entry.id, fetch);
  }

  const tally = (outcome: ObjectOutcome) => {
    if (outcome.status === 'unreachable') unreachable += 1;
  };

  async function backfillComments(page: unknown, postId: string, post: Vouch) {
    const source = offeredCollection(page);
    if (!source) return;
    const room = Math.min(limits.commentsPerPost, limits.comments - comments);
    if (room <= 0) return;
    let items: unknown[];
    try {
      items = await readCollection(source, fetch, { pages: limits.collectionPages, items: room });
    } catch (error) {
      if (!(error instanceof FetchFailure)) throw error;
      notes.push(`comments of ${postId}: ${error.message}`);
      return;
    }
    const owner = typeof source === 'string' ? source : postId;
    for (const item of items) {
      const entry = entryOf(item);
      if (!entry || budget.spent || options.signal?.aborted) continue;
      const loaded = await load(entry, owner);
      if (!('json' in loaded)) {
        tally(loaded);
        continue;
      }
      const outcome = await storeObject(loaded.json, post, { fetch, depth: 0 });
      tally(outcome);
      if (outcome.status === 'stored' && outcome.created && outcome.kind === 'comment') comments += 1;
    }
  }

  for (const [label, url] of [
    ['featured', community.featuredUrl],
    ['outbox', community.outboxUrl],
  ] as const) {
    if (!url) continue;
    let items: unknown[];
    try {
      items = await readCollection(url, fetch, { pages: limits.collectionPages, items: limits.collectionItems });
    } catch (error) {
      if (!(error instanceof FetchFailure)) throw error;
      // Pinned posts are a bonus; the outbox is the backfill.
      if (label === 'outbox' && isTransient(error) && !budget.spent)
        return { outcome: 'retry', posts, comments, note: `outbox: ${error.message}` };
      notes.push(`${label}: ${error.message}`);
      continue;
    }
    for (const item of items) {
      if (posts >= limits.posts) {
        notes.push(`stopped at ${limits.posts} posts`);
        break;
      }
      if (options.signal?.aborted) return { outcome: 'retry', posts, comments, note: 'interrupted by the worker stopping' };
      const entry = entryOf(item);
      if (!entry || seen.has(entry.id) || budget.spent) continue;
      seen.add(entry.id);
      const loaded = await load(entry, community.apId);
      if (!('json' in loaded)) {
        tally(loaded);
        continue;
      }
      const outcome = await storeObject(loaded.json, vouch(url), { fetch, depth: 0 });
      tally(outcome);
      if (outcome.status !== 'stored') continue;
      if (outcome.created) posts += 1;
      await backfillComments(loaded.json, entry.id, vouch(url));
    }
  }
  if (budget.spent) notes.push(`stopped at ${limits.requests} requests`);
  if (unreachable > 0) notes.push(`${unreachable} objects could not be reached`);
  return { outcome: 'done', posts, comments, note: notes.join('; ') || null };
}

export type BackfillRunOptions = BackfillOptions & {
  signal?: AbortSignal;
  /** Backfills one run of the job takes. */
  maxRuns?: number;
  now?: () => Date;
};

/** Claims due backfills one at a time, runs and settles each; returns how many it ran. */
export async function backfillDue(options: BackfillRunOptions = {}): Promise<number> {
  const limits = options.limits ?? backfillLimits;
  const now = options.now ?? (() => new Date());
  const principal = await systemPrincipal(db(), 'scheduled');
  let ran = 0;
  while (!options.signal?.aborted && ran < (options.maxRuns ?? 3)) {
    const claimGrant = await authorize('remote.backfill_claim', principal, {});
    if (!claimGrant.ok) throw new Error(`remote.backfill_claim refused: ${claimGrant.reason}`);
    const claimed = await claimBackfill(claimGrant.grant, { now: now() });
    if (!claimed) break;
    ran += 1;

    let report: BackfillReport;
    if (claimed.attempt > maxBackfillAttempts) {
      report = { outcome: 'failed', posts: 0, comments: 0, note: 'gave up: the backfill kept stopping before it finished' };
    } else {
      try {
        report = await runBackfill(claimed, options);
      } catch (error) {
        console.error(`backfill of ${claimed.apId} broke`, error);
        report = { outcome: 'retry', posts: 0, comments: 0, note: error instanceof Error ? error.message : String(error) };
      }
    }
    const wait = limits.retryAfterMs[claimed.attempt - 1];
    const result: BackfillResult =
      report.outcome === 'retry' && wait !== undefined
        ? { outcome: 'retry', posts: report.posts, comments: report.comments, note: report.note, retryAt: new Date(now().getTime() + wait) }
        : {
            outcome: report.outcome === 'done' ? 'done' : 'failed',
            posts: report.posts,
            comments: report.comments,
            note: report.note,
            now: now(),
          };
    const settleGrant = await authorize('remote.backfill_settle', principal, { communityId: claimed.communityId });
    if (!settleGrant.ok) throw new Error(`remote.backfill_settle refused: ${settleGrant.reason}`);
    await settleBackfill(settleGrant.grant, result);
  }
  return ran;
}
