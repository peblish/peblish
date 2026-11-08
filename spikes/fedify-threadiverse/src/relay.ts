// FEP-1b12 fan-out: a local community wraps an activity in an Announce to its
// followers. Never Announce(Page); Lemmy rejects it and PieFed ignores it.
// Every Announce goes through the durable outbox (outbox.ts).
import type { Context } from "@fedify/fedify";
import { type Activity, Announce, PUBLIC_COLLECTION } from "@fedify/vocab";
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
