// FEP-1b12 fan-out: a local community wraps an activity in an Announce to its
// followers. Never Announce(Page) to threadiverse peers: Lemmy rejects it
// (CannotReceivePage) and PieFed ignores it. Mastodon understands only that
// shape, so `announcePageCompat` sends it to chosen inboxes alone.
// Every Announce goes through the durable outbox (outbox.ts).
import type { Context } from "@fedify/fedify";
import { type Activity, Announce, type Page, PUBLIC_COLLECTION } from "@fedify/vocab";
import { newActivityUri } from "./content.ts";
import { sql } from "./db.ts";
import { enqueue } from "./outbox.ts";

/** Distinct delivery targets of a local actor's followers, shared inbox first. */
export async function followerInboxes(identifier: string, skipOrigin?: string): Promise<string[]> {
  const rows = await sql<{ inbox: string }[]>`
    select distinct coalesce(shared_inbox, inbox) as inbox from followers
    where local_identifier = ${identifier}`;
  return rows.map((row) => row.inbox).filter((inbox) => new URL(inbox).origin !== skipOrigin);
}

/** Follower inboxes of a local actor whose origin is one of `origins`. */
export async function followerInboxesAt(identifier: string, origins: string[]): Promise<string[]> {
  const wanted = new Set(origins.map((origin) => new URL(origin).origin));
  return (await followerInboxes(identifier)).filter((inbox) => wanted.has(new URL(inbox).origin));
}

/**
 * Mastodon-compatible copy of a post: an Announce whose object is the Page
 * itself, the second copy Lemmy sends to every follower. Mastodon drops
 * Announce(Create(Page)) and fetches the Page by id from this one. Sent only
 * to the inboxes given (microblog followers), never to threadiverse peers.
 */
export async function announcePageCompat(
  ctx: Context<void>,
  community: string,
  page: Page,
  inboxes: string[],
): Promise<void> {
  const announce = new Announce({
    id: newActivityUri("Announce"),
    actor: ctx.getActorUri(community),
    object: page,
    tos: [PUBLIC_COLLECTION],
    ccs: [ctx.getFollowersUri(community)],
  });
  await enqueue(community, announce, inboxes);
}

/** Announces one of our own activities (Fedify's compacted JSON is fine for those). */
export async function announceLocal(ctx: Context<void>, community: string, activity: Activity): Promise<void> {
  const announce = new Announce({
    id: newActivityUri("Announce"),
    actor: ctx.getActorUri(community),
    object: activity,
    tos: [PUBLIC_COLLECTION],
    ccs: [ctx.getFollowersUri(community)],
  });
  await enqueue(community, announce, await followerInboxes(community));
}

/**
 * Announces another server's activity with its JSON exactly as received.
 * Fedify's serialiser JSON-LD-compacts, which collapsed one-element arrays and
 * dropped terms outside the sender's @context; Lemmy's strict parser rejected
 * the result. Also used for types Fedify's vocabulary lacks (Lemmy's Lock).
 * `skipOrigin` is the origin that already has it (the sender).
 */
export async function announceRaw(
  ctx: Context<void>,
  community: string,
  object: Record<string, unknown>,
  skipOrigin?: string,
): Promise<void> {
  const announce = {
    "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
    id: newActivityUri("Announce").href,
    type: "Announce",
    actor: ctx.getActorUri(community).href,
    to: [PUBLIC_COLLECTION.href],
    cc: [ctx.getFollowersUri(community).href],
    object,
  };
  await enqueue(community, announce, await followerInboxes(community, skipOrigin));
}
