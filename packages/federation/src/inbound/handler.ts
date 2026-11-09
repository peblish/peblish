import type { ResolvedActor } from '../actors/resolve.ts';
import type { Fetcher } from '../actors/document.ts';
import type { JsonObject } from '../mapping/json.ts';
import type { Activity, PostRecord } from '../mapping/records.ts';
import type { Tx } from '@peblish/core/tx/tx';

// The handler registry's contract (registered by glob: each file under inbound/handlers/ exports
// `handler`, one per ActivityStreams type). The pipeline (pipeline.ts) has already verified the
// signature, checked the activity's origins and mapped it. A handler works in two steps so the
// network never runs inside the transaction:
//
// 1. `prepare` reads what it needs (resolves actors, refetches a collection), decides what the
//    activity is about and returns the `apply` step. It may throw `skip(reason)`.
// 2. `apply` runs inside the one transaction that also holds the dedupe marker, and calls core
//    mutations through `.within(t, grant, input)`. It may throw `skip(reason)` or let a
//    mutation's `Refused` through; either way the transaction rolls back and the row is
//    recorded as skipped with that reason.

/** How the activity reached us: inside a community's Announce, or from its actor. */
export type AnnounceInfo = { apId: string; community: ResolvedActor };

/** What an applied activity did, for the pipeline's own follow-up (relay, requeue). */
export type Applied = {
  /** The community the change happened in; a local one relays what arrived directly. */
  communityId?: string;
  /** The ap_id of what the activity is about, for activities.object_ap_id. */
  objectApId?: string;
  /** Posts or comments this activity stored: skipped rows waiting on these ap_ids go back to pending. */
  stored?: readonly string[];
  /** A newly stored post, so Mastodon-like followers get the Announce(Page) copy. */
  page?: PostRecord;
  /** Whether a local community announces this to its followers (content and moderation, not follows). */
  relay?: boolean;
};

export type Apply = (t: Tx) => Promise<Applied>;

/** What a handler gets for one activity (the inner one, when it arrived inside an Announce). */
export interface InboundContext {
  readonly activity: Activity;
  /** The activity's JSON as received (the inner copy when announced). */
  readonly raw: JsonObject;
  /** The activity's actor, resolved: stored, or fetched and stored. */
  readonly sender: ResolvedActor;
  readonly announce: AnnounceInfo | null;
  readonly fetch: Fetcher;
  /** This server's origin. */
  readonly origin: string;
  /** A stored or fetched actor; throws `skip('actor.unresolvable')` for one that cannot be had, or a transient failure to retry. */
  actor(apId: string): Promise<ResolvedActor>;
  /** Whether an activity id was applied already (the pipeline skips a copy before any fetch). */
  seen(activityId: string): Promise<boolean>;
  handlerFor(type: string): InboundHandler | undefined;
  /**
   * A context for an activity found inside this one (an Announce's, an Undo's), acting as its
   * own actor. `announce` is set when a community's Announce carried it.
   */
  nested(activity: Activity, raw: JsonObject, announce: AnnounceInfo | null): Promise<InboundContext>;
}

/**
 * A prepared activity: the step to run in the transaction, and the activity it applies (the
 * dedupe key and the `activities` row). `announced` is whether it arrived inside an Announce,
 * which decides the relay: a local community announces only what reached it directly.
 */
export type Prepared = { apply: Apply; activity: Activity; raw: JsonObject; announced: boolean };

/** The usual Prepared: the context's own activity, with the step to apply it. */
export const prepared = (ctx: InboundContext, apply: Apply): Prepared => ({
  apply,
  activity: ctx.activity,
  raw: ctx.raw,
  announced: ctx.announce !== null,
});

export interface InboundHandler {
  /** The ActivityStreams type handled, such as 'Create', 'Like' or 'Flag'. */
  readonly type: string;
  prepare(ctx: InboundContext): Promise<Prepared>;
  /**
   * Reverses `undone` (the activity of this type inside an Undo whose actor is the undone
   * activity's actor, already checked). Absent for types nothing can undo.
   */
  undo?(ctx: InboundContext, undone: Activity): Promise<Prepared>;
}
