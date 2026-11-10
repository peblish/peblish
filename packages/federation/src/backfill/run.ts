import { authorize } from '@peblish/core/authz/authorize';
import { systemPrincipal } from '@peblish/core/authz/system';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { posts as postRows } from '@peblish/core/db/tables/content';
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
import { federationOn } from '../actors/federation-switch.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import type { JsonObject } from '../mapping/json.ts';
import { refreshRemoteActor } from '../remote-fetch/actor.ts';
import { readCollection, type CollectionItem } from '../remote-fetch/collection.ts';
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

/** `envelopes`: the Create, Update and Announce activities the object was unwrapped from, outermost first. */
type Entry = { id: string; embedded: JsonObject | null; envelopes: readonly JsonObject[] };
const contentTypes = new Set(['Page', 'Article', 'Video', 'Note']);

/**
 * What a collection item points at: the object in a Create, Update or Announce, a bare object,
 * or an IRI. The activities around it are kept, since storeObject holds each to the visibility
 * rule (a followers-only Create of a Page that names Public is not public).
 */
function entryOf(item: unknown, envelopes: readonly JsonObject[] = []): Entry | null {
  if (typeof item === 'string') return URL.canParse(item) ? { id: item, embedded: null, envelopes } : null;
  if (!isObject(item)) return null;
  if (item.type === 'Create' || item.type === 'Announce' || item.type === 'Update') return entryOf(item.object, [...envelopes, item]);
  if (typeof item.id === 'string' && URL.canParse(item.id) && typeof item.type === 'string' && contentTypes.has(item.type)) {
    return { id: item.id, embedded: item, envelopes };
  }
  return null;
}

/** The collection a post offers its comments in: FEP-7888's `context`, else `replies`. Neither is a link to the post itself. */
function offeredCollection(post: unknown): string | JsonObject | null {
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
  /** The clock the lease and the time limit are read against (tests). */
  now?: () => Date;
};

/**
 * Runs one claimed backfill and says how it ended; the caller settles it. Never throws for a
 * peer's behaviour (down, slow, malformed): that is a retry, a failure or a note.
 */
export async function runBackfill(claimed: ClaimedBackfill, options: BackfillOptions = {}): Promise<BackfillReport> {
  const limits = options.limits ?? backfillLimits;
  const base = options.fetch ?? safeFetch;
  const clock = options.now ?? (() => new Date());
  // The run settles under the claim it holds, and the claim is only good for its lease: it makes
  // no request in the last `settleMarginMs` of it, so a long backfill ends (keeping what it
  // stored) before another worker can take the row over.
  const stopAt = claimed.leaseUntil.getTime() - limits.settleMarginMs;
  const budget = { used: 0, spent: false, timedOut: false };
  const counted: Fetcher = (url, init) => {
    if (clock().getTime() >= stopAt) {
      budget.spent = budget.timedOut = true;
      return Promise.reject(new Error('the backfill ran out of time'));
    }
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
  const communityOrigin = originOf(community.apId);

  type Loaded = { json: unknown; /** The origin that actually served these bytes. */ origin: string };

  /**
   * An object's document: the one embedded in the collection page that listed it when its id is
   * on the origin that served that page (`carrier`, read off the page by readCollection), else
   * read from where it lives. Either way its id is the entry's (readObject checks that for a
   * fetched one), and `origin` is where the bytes came from.
   */
  async function load(entry: Entry, carrier: string): Promise<Loaded | ObjectOutcome> {
    if (entry.embedded && originOf(entry.id) === carrier) {
      return entry.embedded.id === entry.id
        ? { json: entry.embedded, origin: carrier }
        : { status: 'refused', apId: entry.id, reason: 'object.id_mismatch' };
    }
    const read = await readObject(entry.id, fetch);
    return 'json' in read ? { json: read.json, origin: originOf(read.served) } : read;
  }

  const tally = (outcome: ObjectOutcome) => {
    if (outcome.status === 'unreachable') unreachable += 1;
  };

  /**
   * The comments a stored post offers in its `context` or `replies` collection. The post's
   * author controls that collection, so it is trusted for nothing but comments on that post:
   * the post was listed by the community's own collection (the evidence that it belongs here),
   * the collection, its `first` page and every page read are on the origin that served the post
   * or the community's, and a comment is stored only once what it replies to is the post or a
   * comment already stored from the collection. A comment embedded in a page counts as served
   * by its own origin only when that origin served the page. Pages and replies to anything else
   * are refused, and every comment stored counts against the caps.
   */
  async function backfillComments(postJson: unknown, postApId: string, via: Vouch, postOrigin: string) {
    const source = offeredCollection(postJson);
    if (!source) return;
    const room = Math.min(limits.commentsPerPost, limits.comments - comments);
    if (room <= 0) return;
    const [post] = await db().select({ id: postRows.id }).from(postRows).where(eq(postRows.apId, postApId));
    if (!post) return;
    let items: CollectionItem[];
    try {
      items = await readCollection(
        source,
        fetch,
        { pages: limits.collectionPages, items: room },
        { origins: [postOrigin, communityOrigin], servedFrom: postOrigin },
      );
    } catch (error) {
      if (!(error instanceof FetchFailure)) throw error;
      notes.push(`comments of ${postApId}: ${error.message}`);
      return;
    }
    const waiting: { id: string; parent: string; json: unknown; envelopes: readonly JsonObject[] }[] = [];
    for (const { item, origin } of items) {
      const entry = entryOf(item);
      if (!entry || budget.spent || options.signal?.aborted) continue;
      const loaded = await load(entry, origin);
      if (!('json' in loaded)) {
        tally(loaded);
        continue;
      }
      const parent = isObject(loaded.json) ? loaded.json.inReplyTo : undefined;
      if (typeof parent === 'string') waiting.push({ id: entry.id, parent, json: loaded.json, envelopes: entry.envelopes });
    }
    // Thread order, whatever order the collection lists them in.
    const placed = new Set([postApId]);
    for (let progress = true; progress && waiting.length > 0;) {
      progress = false;
      for (const next of waiting.filter((comment) => placed.has(comment.parent))) {
        waiting.splice(waiting.indexOf(next), 1);
        progress = true;
        if (budget.spent || options.signal?.aborted) continue;
        const outcome = await storeObject(next.json, via, {
          fetch,
          depth: 0,
          confine: { kind: 'comment', postId: post.id },
          envelopes: next.envelopes,
        });
        tally(outcome);
        if (outcome.status !== 'stored') continue;
        placed.add(next.id);
        if (outcome.created) comments += 1;
      }
    }
  }

  for (const [label, url] of [
    ['featured', community.featuredUrl],
    ['outbox', community.outboxUrl],
  ] as const) {
    if (!url) continue;
    let items: CollectionItem[];
    try {
      items = await readCollection(
        url,
        fetch,
        { pages: limits.collectionPages, items: limits.collectionItems },
        { origins: [originOf(url)], servedFrom: originOf(url) },
      );
    } catch (error) {
      if (!(error instanceof FetchFailure)) throw error;
      // Pinned posts are a bonus; the outbox is the backfill.
      if (label === 'outbox' && isTransient(error) && !budget.spent)
        return { outcome: 'retry', posts, comments, note: `outbox: ${error.message}` };
      notes.push(`${label}: ${error.message}`);
      continue;
    }
    for (const { item, origin } of items) {
      if (posts >= limits.posts) {
        const capped = `stopped at ${limits.posts} posts`;
        if (!notes.includes(capped)) notes.push(capped);
        break;
      }
      if (options.signal?.aborted) return { outcome: 'retry', posts, comments, note: 'interrupted by the worker stopping' };
      const entry = entryOf(item);
      if (!entry || seen.has(entry.id) || budget.spent) continue;
      seen.add(entry.id);
      const loaded = await load(entry, origin);
      if (!('json' in loaded)) {
        tally(loaded);
        continue;
      }
      const outcome = await storeObject(loaded.json, vouch(url), {
        fetch,
        depth: 0,
        confine: { kind: 'post' },
        envelopes: entry.envelopes,
      });
      tally(outcome);
      if (outcome.status !== 'stored') continue;
      if (outcome.created) posts += 1;
      await backfillComments(loaded.json, outcome.apId, vouch(url), loaded.origin);
    }
  }
  if (budget.timedOut) notes.push('stopped at the end of its lease');
  else if (budget.spent) notes.push(`stopped at ${limits.requests} requests`);
  if (unreachable > 0) notes.push(`${unreachable} objects could not be reached`);
  return { outcome: 'done', posts, comments, note: notes.join('; ') || null };
}

export type BackfillRunOptions = BackfillOptions & {
  /** Backfills one run of the job takes. */
  maxRuns?: number;
};

/**
 * Claims due backfills one at a time, runs and settles each; returns how many it ran. With the
 * federation switch off it claims nothing, so a queued backfill waits without spending an attempt.
 */
export async function backfillDue(options: BackfillRunOptions = {}): Promise<number> {
  const limits = options.limits ?? backfillLimits;
  const now = options.now ?? (() => new Date());
  const principal = await systemPrincipal(db(), 'scheduled');
  let ran = 0;
  while (!options.signal?.aborted && ran < (options.maxRuns ?? 3)) {
    if (!(await federationOn())) break;
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
    const claim = { attempt: claimed.attempt, leaseUntil: claimed.leaseUntil };
    const result: BackfillResult =
      report.outcome === 'retry' && wait !== undefined
        ? {
            claim,
            outcome: 'retry',
            posts: report.posts,
            comments: report.comments,
            note: report.note,
            retryAt: new Date(now().getTime() + wait),
          }
        : {
            claim,
            outcome: report.outcome === 'done' ? 'done' : 'failed',
            posts: report.posts,
            comments: report.comments,
            note: report.note,
            now: now(),
          };
    const settleGrant = await authorize('remote.backfill_settle', principal, { communityId: claimed.communityId });
    if (!settleGrant.ok) throw new Error(`remote.backfill_settle refused: ${settleGrant.reason}`);
    if (!(await settleBackfill(settleGrant.grant, result)).settled) {
      console.warn(`backfill of ${claimed.apId} (attempt ${claimed.attempt}) ended after its lease ran out; the result is dropped`);
    }
  }
  return ran;
}
