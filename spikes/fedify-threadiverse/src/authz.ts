// One place that decides whether an inbound activity may change state here.
//
// Rights, checked in this order against the activity's (signature-verified
// or origin-verified) actor:
//   owner      the actor wrote the target object
//   community  the actor is the community itself
//   moderator  the actor is in the community's moderator list: our table for
//              local communities, the collection the community publishes on
//              its own origin for remote ones
// Each handler names which rights suffice. An activity that arrived inside an
// Announce is also refused unless the announcing Group is the community the
// target belongs to. Refusals are logged to inbox_log by the caller and the
// raw request stays in captures/inbound.jsonl.
import type { Context } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { type ObjectRow, sql } from "./db.ts";
import { localGroup } from "./federation.ts";

const logger = getLogger(["feddit", "authz"]);

export type Right = "owner" | "community" | "moderator";

export type Verdict =
  | { ok: true; right: Right | "reporter" }
  | { ok: false; reason: string };

const deny = (reason: string): Verdict => ({ ok: false, reason });

export interface AuthzRequest {
  actor: URL;
  community: URL | null;
  /** author_uri of the target object, when there is one */
  owner?: string | null;
  allow: readonly Right[];
  /** the Group that announced the activity, when it was not delivered directly */
  announcer?: URL | null;
}

export async function authorize(ctx: Context<void>, request: AuthzRequest): Promise<Verdict> {
  const { actor, community, owner, allow, announcer } = request;
  if (announcer) {
    if (!community) return deny(`announced by ${announcer.href}, but the target has no community`);
    if (announcer.href !== community.href) {
      return deny(`announced by ${announcer.href}, but the target belongs to ${community.href}`);
    }
  }
  if (allow.includes("owner") && owner != null && owner === actor.href) return { ok: true, right: "owner" };
  if (allow.includes("community") && community?.href === actor.href) return { ok: true, right: "community" };
  if (allow.includes("moderator") && community && (await isModerator(ctx, community, actor))) {
    return { ok: true, right: "moderator" };
  }
  return deny(`${actor.href} is not ${allow.join(" or ")} of ${community?.href ?? owner ?? "the target"}`);
}

/**
 * Origin rules for an activity Feddit did not receive from its author:
 * its id and its actor must share one origin (a server speaks only for its
 * own users). An embedded copy is trusted only from that same origin; any
 * other copy must have been fetched from the activity's own origin, which
 * Fedify's getObject does, and inbox.ts does for the raw JSON.
 */
export function originMismatch(activityId: URL | null, actorId: URL | null): string | null {
  if (!activityId || !actorId) return "activity without id or actor";
  if (activityId.origin !== actorId.origin) {
    return `activity id origin ${activityId.origin} does not match actor origin ${actorId.origin}`;
  }
  return null;
}

/**
 * Anyone may report, but only content stored here and posted in a community
 * hosted here: reports go to the moderators of the hosting instance.
 */
export async function authorizeReport(ctx: Context<void>, reporter: URL, targets: readonly ObjectRow[]): Promise<Verdict> {
  if (targets.length === 0) return deny(`${reporter.href} reported content that is not stored here`);
  const foreign = targets.find((row) => !localGroup(ctx, row.community_uri ? new URL(row.community_uri) : null));
  if (foreign) return deny(`${foreign.uri} is not in a community hosted here`);
  return { ok: true, right: "reporter" };
}

// ------------------------------------------------------------------ moderator lists

const REFRESH_AFTER_MS = 30_000;

export async function isModerator(ctx: Context<void>, community: URL, actor: URL): Promise<boolean> {
  const local = localGroup(ctx, community);
  if (local) {
    const [row] = await sql`
      select 1 from community_moderators where community_identifier = ${local} and actor_uri = ${actor.href}`;
    return row != null;
  }
  const cached = await sql<{ moderators: string[]; age_ms: number }[]>`
    select moderators, extract(epoch from now() - fetched_at) * 1000 as age_ms
    from remote_moderators where community_uri = ${community.href}`;
  const entry = cached[0];
  if (entry?.moderators.includes(actor.href)) return true;
  // A miss on a stale list refetches once (a moderator may have just been added).
  if (entry && entry.age_ms < REFRESH_AFTER_MS) return false;
  const fresh = await fetchRemoteModerators(ctx, community);
  return fresh?.includes(actor.href) ?? false;
}

const asUrl = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  return null;
};

/** Lemmy points `attributedTo` at the collection; PieFed also sets `moderators`. */
export async function fetchRemoteModerators(ctx: Context<void>, community: URL): Promise<string[] | null> {
  try {
    const { document: group } = await ctx.documentLoader(community.href);
    if (!group || typeof group !== "object") return null;
    const fields = group as Record<string, unknown>;
    const pointer = asUrl(fields.moderators) ?? asUrl(fields.attributedTo);
    if (!pointer) return null;
    const collectionUri = new URL(pointer, community);
    // Only the community's own server may say who moderates it.
    if (collectionUri.origin !== community.origin) {
      logger.warn("Moderators of {community} listed off-origin at {collection}", {
        community: community.href,
        collection: collectionUri.href,
      });
      return null;
    }
    const { document: collection } = await ctx.documentLoader(collectionUri.href);
    const items = (collection as Record<string, unknown>)?.orderedItems ?? (collection as Record<string, unknown>)?.items;
    const moderators = (Array.isArray(items) ? items : []).map(asUrl).filter((uri) => uri != null);
    await sql`
      insert into remote_moderators (community_uri, collection_uri, moderators)
      values (${community.href}, ${collectionUri.href}, ${moderators})
      on conflict (community_uri) do update set
        collection_uri = excluded.collection_uri, moderators = excluded.moderators, fetched_at = now()`;
    return moderators;
  } catch (error) {
    logger.warn("Could not load moderators of {community}: {error}", { community: community.href, error });
    return null;
  }
}

/** Forget a remote list after an Add/Remove on it, so the next check refetches. */
export async function invalidateRemoteModerators(community: URL): Promise<void> {
  await sql`delete from remote_moderators where community_uri = ${community.href}`;
}

// ------------------------------------------------------------------ bans

export async function isBanned(community: URL, actor: URL): Promise<boolean> {
  const [row] = await sql`
    select 1 from bans where community_uri = ${community.href} and actor_uri = ${actor.href}
      and (expires is null or expires > now())`;
  return row != null;
}
