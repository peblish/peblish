import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { activities, inboxDedupe } from '@peblish/core/db/tables/federation';
import { follows } from '@peblish/core/db/tables/follows';
import { Refused } from '@peblish/core/tx/refused';
import { tx } from '@peblish/core/tx/tx';
import { and, eq, isNull } from 'drizzle-orm';
import { ActorResolveError, resolveRemoteActor, type ResolvedActor, type ResolveOptions } from '../actors/resolve.ts';
import type { Fetcher } from '../actors/document.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import { localOrigin } from '../federation.ts';
import { activityFromWire } from '../mapping/activity.ts';
import { MappingError, type JsonObject } from '../mapping/json.ts';
import type { Activity } from '../mapping/records.ts';
import { relayToFollowers } from '../relay/announce.ts';
import { inboundHandlers } from '../registry/inbound-handlers.gen.ts';
import { checkActivityOrigin, checkNotEcho } from './authorize.ts';
import { classify, type ClassifyEnv, type Item } from './classify.ts';
import type { AnnounceInfo, InboundContext, InboundHandler, Prepared } from './handler.ts';
import { renewLease, requeueWaiting, settle, settleAlone, type InboxRow, type Settled } from './queue.ts';
import { Skipped, skip } from './reasons.ts';
import { takePipelineFetch } from './throttle.ts';

// One inbox_raw row from receipt to its end state. The signature was verified when the row was
// stored (receive.ts), so the key's owner is the activity's actor. From there:
//
// 1. classify (classify.ts): what the document is; a type we do not read, a poll or a bare
//    Announce is skipped here, a batched Announce becomes one Announce per activity.
// 2. map (activityFromWire): a MappingError is permanent, the row fails and is never retried.
// 3. prepare (the handler for the type): origins, the sender and every actor the activity
//    names are resolved, a missing object is found missing. All network work is here.
// 4. one transaction: the dedupe marker for the applied activity (the inner one inside an
//    Announce, so a direct and an announced copy apply once), the handler's mutations, the
//    `activities` row linked to the inbox row, the relay's deliveries, the rows that waited
//    for what was just stored, and the end state. A skip (a policy's refusal, a missing
//    target) rolls all of it back and the row is recorded as skipped with the reason.
//
// Anything else that throws is transient (a peer down, the database): the row is tried again
// later (queue.ts retryLater) and, past maxAttempts, fails with the last error.

export type PipelineOptions = {
  fetch?: Fetcher;
  /** Test hook: runs inside the transaction between the handler's apply and the relay's enqueue. */
  afterApply?: () => Promise<void>;
};

type ItemResult = { applied: true } | { skipped: Skipped } | { failed: string };

type Env = {
  fetch: Fetcher;
  origin: string;
  actor(apId: string, options?: Pick<ResolveOptions, 'maxAgeMs'>): Promise<ResolvedActor>;
  seen(activityId: string): Promise<boolean>;
  classify: ClassifyEnv;
  afterApply: (() => Promise<void>) | undefined;
};

/** Most fetches one delivery may cost, so a batched Announce naming many strangers cannot fan out without end. */
export const fetchesPerRow = 60;

/**
 * `base` counted against this row's allowance and the pipeline's window (throttle.ts). A fetch
 * past either fails like an unreachable peer, which the pipeline retries later, so a delivery
 * that needs more than its share waits instead of being lost. Each fetch also renews the row's
 * lease, so a delivery that spends minutes on slow peers is not taken from the worker doing it.
 */
function budgeted(base: Fetcher, row: InboxRow): Fetcher {
  let left = fetchesPerRow;
  return async (url, init) => {
    if (left <= 0 || !takePipelineFetch(new URL(String(url)).host))
      throw new Error('this delivery needs more fetches than it may make now');
    left -= 1;
    await renewLease(row);
    return base(url, init);
  };
}

const handlers = new Map<string, InboundHandler>(inboundHandlers.map((handler) => [handler.type, handler]));

async function resolveActor(apId: string, fetch: Fetcher, options: Pick<ResolveOptions, 'maxAgeMs'> = {}): Promise<ResolvedActor> {
  try {
    return await resolveRemoteActor(apId, { fetch, ...options });
  } catch (error) {
    // A peer that is down is retried; an actor that is gone, blocked or malformed will not change.
    if (error instanceof ActorResolveError && !error.transient) throw skip('actor.unresolvable', apId);
    throw error;
  }
}

async function makeEnv(options: PipelineOptions, row: InboxRow): Promise<Env> {
  const fetch = budgeted(options.fetch ?? safeFetch, row);
  return {
    fetch,
    origin: await localOrigin(),
    actor: (apId, options) => resolveActor(apId, fetch, options),
    seen: async (activityId) =>
      (await db().select({ id: inboxDedupe.activityId }).from(inboxDedupe).where(eq(inboxDedupe.activityId, activityId))).length > 0,
    classify: {
      isLocalCommunity: async (apId) =>
        (
          await db()
            .select({ id: actors.id })
            .from(actors)
            .where(and(eq(actors.apId, apId), eq(actors.local, true), eq(actors.kind, 'Group'), isNull(actors.deletedAt)))
        ).length > 0,
      followerOf: async (followApId) => {
        const [row] = await db()
          .select({ apId: actors.apId })
          .from(follows)
          .innerJoin(actors, eq(actors.id, follows.followerId))
          .where(and(eq(follows.apId, followApId), eq(actors.local, true)));
        return row?.apId ?? null;
      },
    },
    afterApply: options.afterApply,
  };
}

async function contextFor(env: Env, activity: Activity, raw: JsonObject, announce: AnnounceInfo | null): Promise<InboundContext> {
  // A Delete or an Undo comes from an actor that may be gone, and a stale copy refetched to
  // answer 410 would be deleted before the activity is read, dropping a Delete with removeData.
  // The copy we hold is enough to say who sent it.
  const leaving = activity.type === 'Delete' || activity.type === 'Undo';
  return {
    activity,
    raw,
    sender: await env.actor(activity.actorApId, leaving ? { maxAgeMs: Infinity } : undefined),
    announce,
    fetch: env.fetch,
    origin: env.origin,
    actor: env.actor,
    seen: env.seen,
    handlerFor: (type) => handlers.get(type),
    nested: (inner, innerRaw, via) => contextFor(env, inner, innerRaw, via),
  };
}

/** Dedupe, apply, record, relay and settle: the one transaction. */
async function applyOnce(row: InboxRow, prepared: Prepared, env: Env, settleHere: boolean, rewritten: boolean): Promise<void> {
  const { activity, raw, apply, announced } = prepared;
  await tx(async (t) => {
    if (!(await t.dedupe(activity.id))) throw skip('duplicate');
    const applied = await apply(t);
    await env.afterApply?.();
    await t.db
      .insert(activities)
      .values({
        apId: activity.id,
        type: activity.type,
        actorApId: activity.actorApId,
        objectApId: applied.objectApId ?? null,
        local: false,
        raw,
        inboxRawId: row.id,
      })
      .onConflictDoNothing();
    // A local community announces what reached it directly; what came inside an Announce is a remote community's business.
    if (applied.relay && applied.communityId && !announced) {
      await relayToFollowers(t, {
        communityId: applied.communityId,
        // A rewritten Note (a microblog post made into a Page) goes to threadiverse followers as the
        // Page it was stored as: Lemmy and its kin read no top-level Note as a post.
        body: rewritten ? new TextEncoder().encode(JSON.stringify(raw)) : row.body,
        json: raw,
        senderApId: activity.actorApId,
        page: applied.page,
      });
    }
    await requeueWaiting(t, applied.stored ?? []);
    if (settleHere) await settle(t, row, { state: 'applied', error: null });
  });
}

async function processItem(row: InboxRow, json: JsonObject, env: Env, settleHere: boolean, rewritten: boolean): Promise<ItemResult> {
  try {
    const activity = activityFromWire(json);
    checkActivityOrigin(activity);
    checkNotEcho(activity, env.origin);
    // An Announce is deduped by what it carries (announce.ts); everything else by its own id.
    if (activity.type !== 'Announce' && (await env.seen(activity.id))) throw skip('duplicate');
    const handler = handlers.get(activity.type);
    if (!handler) throw skip('type.unhandled', activity.type);
    const prepared = await handler.prepare(await contextFor(env, activity, json, null));
    await applyOnce(row, prepared, env, settleHere, rewritten);
    return { applied: true };
  } catch (error) {
    if (error instanceof Skipped) return { skipped: error };
    if (error instanceof Refused) return { skipped: skip(error.reason) };
    if (error instanceof MappingError) return { failed: error.message };
    throw error;
  }
}

/**
 * One end state for a row that carried several activities: applied if any was, else why none were.
 * A member still waiting for its object keeps the row discoverable even when another member
 * applied: the row is recorded as skipped for that object, goes back in line when the object
 * arrives (queue.ts requeueWaiting), and is processed again with the members that applied
 * protected by their dedupe markers (they come out as `duplicate`).
 */
function aggregate(results: readonly ItemResult[]): Settled {
  const skipped = results.filter((result): result is { skipped: Skipped } => 'skipped' in result).map((result) => result.skipped);
  // A missing object is recorded alone, so the requeue that matches it finds the row.
  const missing = skipped.find((one) => one.reason === 'target.missing');
  if (missing) return { state: 'skipped', error: missing.recorded };
  if (results.some((result) => 'applied' in result)) return { state: 'applied', error: null };
  const failed = results.find((result): result is { failed: string } => 'failed' in result);
  if (failed) return { state: 'failed', error: failed.failed };
  const lead = skipped[0];
  if (!lead) return { state: 'skipped', error: 'announce.empty' };
  return { state: 'skipped', error: skipped.length > 1 ? `${lead.recorded} (+${skipped.length - 1} more)` : lead.recorded };
}

/**
 * Processes one leased row and records how it ended. Returns that end state. A transient failure
 * throws: the caller (the job) hands it to retryLater.
 */
export async function processRow(row: InboxRow, options: PipelineOptions = {}): Promise<Settled> {
  const env = await makeEnv(options, row);
  const end = async (settled: Settled) => {
    await settleAlone(row, settled);
    return settled;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(row.body));
  } catch {
    return end({ state: 'failed', error: 'the body is not JSON' });
  }
  let items: Item[];
  try {
    items = await classify(parsed, env.classify);
  } catch (error) {
    if (error instanceof MappingError) return end({ state: 'failed', error: error.message });
    throw error;
  }
  const single = items.length === 1;
  const results: ItemResult[] = [];
  for (const item of items) {
    // A batch can take a while: keep the lease while its members are worked through.
    if (!single) await renewLease(row);
    results.push('skipped' in item ? { skipped: item.skipped } : await processItem(row, item.json, env, single, item.rewritten === true));
  }
  // A lone applied activity settled the row in its own transaction.
  if (single && results[0] && 'applied' in results[0]) return { state: 'applied', error: null };
  return end(aggregate(results));
}
