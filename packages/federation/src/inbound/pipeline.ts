import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { activities, inboxDedupe } from '@peblish/core/db/tables/federation';
import { follows } from '@peblish/core/db/tables/follows';
import { instanceBlocked } from '@peblish/core/peers/gate';
import { Refused } from '@peblish/core/tx/refused';
import { tx } from '@peblish/core/tx/tx';
import { and, eq, isNull } from 'drizzle-orm';
import { ActorResolveError, resolveRemoteActor, type ResolvedActor, type ResolveOptions } from '../actors/resolve.ts';
import type { Fetcher } from '../actors/document.ts';
import { assertFederationOn, FederationPaused } from '../actors/federation-switch.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import { localOrigin } from '../federation.ts';
import { activityFromWire } from '../mapping/activity.ts';
import { MappingError, type JsonObject } from '../mapping/json.ts';
import type { Activity } from '../mapping/records.ts';
import { relayToFollowers } from '../relay/announce.ts';
import { inboundHandlers } from '../registry/inbound-handlers.gen.ts';
import { checkActivityOrigin, checkNotEcho, storedContent } from './authorize.ts';
import { classify, type ClassifyEnv, type Item } from './classify.ts';
import type { AnnounceInfo, InboundContext, InboundHandler, Prepared } from './handler.ts';
import { holdClaim, renewLease, requeueWaiting, settle, settleAlone, yieldLater, type InboxRow, type Settled } from './queue.ts';
import { Skipped, missingTargets, skip } from './reasons.ts';
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
//
// A fetch the budget refuses (below) is not a failure but a turn given up. A batch of many
// activities from strangers needs more fetches than one claim may make, so the row stops where
// it is, goes back to pending after a short wait with its attempt given back (queue.ts
// yieldLater), and the next claim resumes: members that applied are skipped by their dedupe
// markers and cost nothing. The members cannot be told apart in the row, so a claim that applied
// nothing new before running out of its own allowance is a delivery that needs more than it may
// have, and fails like any transient failure.

export type PipelineOptions = {
  fetch?: Fetcher;
  /** Test hook: runs inside the transaction between the handler's apply and the relay's enqueue. */
  afterApply?: () => Promise<void>;
};

/** The row stepped aside and is pending again (see giveWay). */
export type Yielded = { state: 'pending'; error: string };

type ItemResult = { applied: true } | { skipped: Skipped } | { failed: string };

type Env = {
  budget: FetchBudget;
  fetch: Fetcher;
  origin: string;
  actor(apId: string, options?: Pick<ResolveOptions, 'maxAgeMs'>): Promise<ResolvedActor>;
  seen(activityId: string): Promise<boolean>;
  classify: ClassifyEnv;
  afterApply: (() => Promise<void>) | undefined;
};

/** Most fetches one claim of a delivery may make, so a batched Announce naming many strangers cannot fan out without end. */
export const fetchesPerRow = 60;
/**
 * A member of a batch is started only while this many fetches are left. A new origin costs about
 * four (the object, the actor and two NodeInfo reads); a member cut off halfway wastes what it
 * fetched, and a NodeInfo read the budget refuses is remembered as that peer's failure.
 */
export const memberReserve = 6;

/**
 * Which budget said no: the claim's own allowance, the process-wide window every delivery shares
 * (throttle.ts), or the federation switch, off (actors/federation-switch.ts), which lets no fetch out at all.
 */
type Refusal = 'allowance' | 'window' | 'paused';

/** Seconds a row waits before its next claim after each kind of refusal (the window lasts a minute). */
const waitSeconds: Record<Refusal, number> = { allowance: 5, window: 30, paused: 60 };
const spentMessage = 'this delivery needs more fetches than it may make now';

/** Thrown to stop a row's work for now: a fetch was refused, which is a wait, not a failure. */
class FetchYield extends Error {
  override readonly name = 'FetchYield';
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(spentMessage);
    this.refusal = refusal;
  }
}

type FetchBudget = {
  /** Set once a fetch was refused. Callers further down turn a failed fetch into an unreachable peer, an unknown NodeInfo or a member left out, so the flag, not the error, says it happened. */
  refused: Refusal | null;
  /** Whether a typical member fits in what is left. */
  roomForMember(): boolean;
  fetch: Fetcher;
};

/**
 * `base` counted against this claim's allowance and the pipeline's window (throttle.ts). Each
 * fetch also renews the row's lease, so a delivery that spends minutes on slow peers is not taken
 * from the worker doing it.
 */
function fetchBudget(base: Fetcher, row: InboxRow): FetchBudget {
  let left = fetchesPerRow;
  const budget: FetchBudget = {
    refused: null,
    roomForMember: () => left >= memberReserve,
    fetch: async (url, init) => {
      if (left <= 0) {
        budget.refused ??= 'allowance';
        throw new Error(spentMessage);
      }
      if (!takePipelineFetch(new URL(String(url)).host)) {
        budget.refused ??= 'window';
        throw new Error(spentMessage);
      }
      left -= 1;
      await renewLease(row);
      // The renewal is a database wait: a pause during it stops this request (FederationPaused, a FetchYield below).
      await assertFederationOn();
      return base(url, init);
    },
  };
  return budget;
}

const handlers = new Map<string, InboundHandler>(inboundHandlers.map((handler) => [handler.type, handler]));

/**
 * Every actor the pipeline resolves (the activity's actor, a nested activity's, an actor a
 * handler targets) must be the actor asked for. The resolver follows an actor document's
 * redirects and accepts the address it ends at, so `rogue.test/u/x` redirecting to
 * `victim.test/u/y` resolves to y: a Delete sent as x would delete y. Here the resolved id must
 * equal the requested one exactly. (Finding an actor by an alias, as search does, is resolve/web.ts.)
 */
async function resolveActor(apId: string, fetch: Fetcher, options: Pick<ResolveOptions, 'maxAgeMs'> = {}): Promise<ResolvedActor> {
  let resolved: ResolvedActor;
  try {
    resolved = await resolveRemoteActor(apId, { fetch, ...options });
  } catch (error) {
    // A peer that is down is retried; an actor that is gone, blocked or malformed will not change.
    if (error instanceof ActorResolveError && !error.transient) throw skip('actor.unresolvable', apId);
    throw error;
  }
  if (resolved.apId !== apId) throw skip('actor.id_mismatch', apId);
  return resolved;
}

async function makeEnv(options: PipelineOptions, row: InboxRow): Promise<Env> {
  const budget = fetchBudget(options.fetch ?? safeFetch, row);
  const fetch = budget.fetch;
  return {
    budget,
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
      holds: async (apId) => (await storedContent(db(), apId)) !== null,
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
  const sender = await env.actor(activity.actorApId, leaving ? { maxAgeMs: Infinity } : undefined);
  // A peer blocked after its activity was taken in (or one an Announce carries) changes nothing here.
  if (await instanceBlocked(db(), sender.apId)) throw skip('peer.blocked', sender.apId);
  return {
    activity,
    raw,
    sender,
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
    // Either way the claim is asserted before the commit: a worker that lost the row applies nothing, a member of a batch included.
    if (settleHere) await settle(t, row, { state: 'applied', error: null });
    else await holdClaim(t, row);
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
    // A refused fetch may have been swallowed on the way (a NodeInfo check, a moderator left out
    // of a mirror): what was prepared is not to be applied on top of it.
    if (env.budget.refused) throw new FetchYield(env.budget.refused);
    await applyOnce(row, prepared, env, settleHere, rewritten);
    return { applied: true };
  } catch (error) {
    // Whatever came of the member after a refusal is not its outcome: it is tried again.
    if (env.budget.refused) throw new FetchYield(env.budget.refused);
    // A fetch the switch held back: the row waits for federation to be on again, its attempt given back.
    if (error instanceof FederationPaused) throw new FetchYield('paused');
    if (error instanceof Skipped) return { skipped: error };
    if (error instanceof Refused) return { skipped: skip(error.reason) };
    if (error instanceof MappingError) return { failed: error.message };
    throw error;
  }
}

/**
 * One end state for a row that carried several activities: applied if any was, else why none were.
 * A member still waiting for its object keeps the row discoverable even when another member
 * applied: the row is recorded as skipped for every object its members wait for, goes back in
 * line when any of them arrives (queue.ts requeueWaiting), and is processed again with the
 * members that applied protected by their dedupe markers (they come out as `duplicate`).
 */
function aggregate(results: readonly ItemResult[]): Settled {
  const skipped = results.filter((result): result is { skipped: Skipped } => 'skipped' in result).map((result) => result.skipped);
  // Every object a member waits for is recorded, so the arrival of any one finds the row.
  const missing = skipped.filter((one) => one.reason === 'target.missing');
  if (missing.length > 0) {
    const waiting = [...new Set(missing.flatMap((one) => (one.detail && !/\s/.test(one.detail) ? [one.detail] : [])))];
    return { state: 'skipped', error: waiting.length > 0 ? missingTargets(waiting) : missing[0]!.recorded };
  }
  if (results.some((result) => 'applied' in result)) return { state: 'applied', error: null };
  const failed = results.find((result): result is { failed: string } => 'failed' in result);
  if (failed) return { state: 'failed', error: failed.failed };
  const lead = skipped[0];
  if (!lead) return { state: 'skipped', error: 'announce.empty' };
  return { state: 'skipped', error: skipped.length > 1 ? `${lead.recorded} (+${skipped.length - 1} more)` : lead.recorded };
}

/**
 * A row whose fetches ran out steps aside: pending again after a short wait, with its attempt
 * given back. The window is shared with every delivery, so running out of it is nobody's fault,
 * and a pause of federation is the admin's.
 * A claim that spent its own allowance without applying anything new is a delivery that needs
 * more than it may have: that throws, and the caller counts an attempt.
 */
async function giveWay(row: InboxRow, refusal: Refusal, results: readonly ItemResult[]): Promise<Yielded> {
  if (refusal === 'allowance' && !results.some((result) => 'applied' in result)) throw new Error(spentMessage);
  const error = {
    window: 'the server is fetching as much as it may; this delivery waits',
    allowance: 'the rest of this delivery waits for a turn to fetch',
    paused: 'federation is paused here; this delivery waits until it is on again',
  }[refusal];
  await yieldLater(row, waitSeconds[refusal], error);
  return { state: 'pending', error };
}

/**
 * Processes one leased row and records how it ended. Returns that end state, or `pending` when
 * the row stepped aside for its fetches (giveWay). A transient failure throws: the caller (the
 * job) hands it to retryLater.
 */
export async function processRow(row: InboxRow, options: PipelineOptions = {}): Promise<Settled | Yielded> {
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
    if (!single) {
      if (!env.budget.roomForMember()) return giveWay(row, 'allowance', results);
      // A batch can take a while: keep the lease while its members are worked through.
      await renewLease(row);
    }
    try {
      results.push('skipped' in item ? { skipped: item.skipped } : await processItem(row, item.json, env, single, item.rewritten === true));
    } catch (error) {
      if (error instanceof FetchYield) return giveWay(row, error.refusal, results);
      throw error;
    }
  }
  // A lone applied activity settled the row in its own transaction.
  if (single && results[0] && 'applied' in results[0]) return { state: 'applied', error: null };
  return end(aggregate(results));
}
