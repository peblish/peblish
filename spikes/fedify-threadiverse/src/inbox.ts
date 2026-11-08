// Inbound activities. Fedify verifies the HTTP signature and that the signing
// key belongs to the activity's actor, then queues the activity; this module
// decides what it may change:
//
// 1. Trust. A direct delivery is trusted as signed. An activity unwrapped from
//    an Announce, or embedded in an Undo, is trusted only when its id shares
//    the container's origin (the announcing server speaks for its own users);
//    any other copy is fetched again from the activity's own origin. Then the
//    activity's id and actor must share one origin (originMismatch).
// 2. Once. Our own activities echoed back are skipped by origin, and every
//    applied activity id is recorded, so a direct copy and an announced copy
//    (Lemmy sends a ban both ways) apply once.
// 3. Rights. authz.ts: owner, moderator or the community itself, and an
//    announced activity must come from the community its target belongs to.
// 4. Relay. An applied activity in a local community that arrived directly is
//    announced to the community's followers with its JSON as received.
//
// Every outcome goes to inbox_log; refusals also go to captures/rejected.jsonl.
import type { Context } from "@fedify/fedify";
import { Accept, Activity, Announce, Article, Follow, Link, Note, Page, Reject } from "@fedify/vocab";
import { authorize, authorizeReport, invalidateRemoteModerators, isBanned, originMismatch } from "./authz.ts";
import { capture } from "./capture.ts";
import { newActivityUri } from "./content.ts";
import * as db from "./db.ts";
import { sql } from "./db.ts";
import { federation, localGroup } from "./federation.ts";
import { enqueue } from "./outbox.ts";
import { announceRaw } from "./relay.ts";

type Via = "direct" | "announce";
type Json = Record<string, unknown>;

interface Inbound {
  activity: Activity;
  /** The activity's JSON from a trusted copy; relayed as is. */
  raw: Json;
  via: Via;
  /** The Group whose Announce carried it. */
  announcer: URL | null;
}

type Outcome = { kind: "applied" | "rejected" | "ignored"; text: string };
const applied = (text: string): Outcome => ({ kind: "applied", text });
const rejected = (text: string): Outcome => ({ kind: "rejected", text: `rejected: ${text}` });
const ignored = (text: string): Outcome => ({ kind: "ignored", text: `ignored: ${text}` });

/** Activity types with a handler below. Lock is not in Fedify's vocabulary. */
const HANDLED = new Set(["Create", "Update", "Delete", "Like", "Dislike", "Undo", "Lock", "Add", "Remove", "Block", "Flag"]);

const isJson = (value: unknown): value is Json => typeof value === "object" && value != null && !Array.isArray(value);

function iri(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isJson(value) && typeof value.id === "string") return value.id;
  return null;
}

function url(value: unknown): URL | null {
  const text = iri(value);
  if (!text) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

async function record(activity: Activity, via: Via, outcome: string, raw?: Json): Promise<void> {
  const type = String(raw?.type ?? activity.constructor.name);
  await db.logInbox({
    activityId: activity.id?.href ?? null,
    type,
    actor: activity.actorId?.href ?? null,
    object: activity.objectId?.href ?? null,
    via,
    outcome,
  });
  if (outcome.startsWith("rejected")) {
    capture("rejected", { type, id: activity.id?.href, actor: activity.actorId?.href, via, outcome, activity: raw });
  }
}

// ------------------------------------------------------------------ trust

async function fetchJson(ctx: Context<void>, target: URL): Promise<Json | null> {
  try {
    const { document } = await ctx.documentLoader(target.href);
    return isJson(document) ? document : null;
  } catch {
    return null;
  }
}

/**
 * The trusted JSON of an activity referenced or embedded by `container`: the
 * embedded copy when it shares the container's origin, otherwise the copy
 * served at its id by its own origin.
 */
async function trustedEmbedded(ctx: Context<void>, value: unknown, container: { id: URL; context: unknown }): Promise<Json | null> {
  const id = url(value);
  if (!id) return null;
  if (isJson(value) && id.origin === container.id.origin) {
    return "@context" in value ? value : { "@context": container.context, ...value };
  }
  const fetched = await fetchJson(ctx, id);
  return fetched && fetched.id === id.href ? fetched : null;
}

async function parseActivity(ctx: Context<void>, raw: Json): Promise<Activity | null> {
  try {
    return await Activity.fromJsonLd(raw, { documentLoader: ctx.documentLoader, contextLoader: ctx.contextLoader });
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ entry point

async function handle(ctx: Context<void>, inbound: Inbound): Promise<void> {
  const { activity, via, raw } = inbound;
  const type = String(raw.type ?? activity.constructor.name);
  const outcome = await decide(ctx, inbound, type);
  await record(activity, via, outcome.text, raw);
}

async function decide(ctx: Context<void>, inbound: Inbound, type: string): Promise<Outcome> {
  const { activity, via } = inbound;
  const mismatch = originMismatch(activity.id, activity.actorId);
  if (mismatch) return rejected(mismatch);
  const id = activity.id!.href;
  if (activity.id!.origin === ctx.canonicalOrigin) return ignored("echo of our own activity");
  if (!HANDLED.has(type)) return ignored(`${type} not handled`);
  // Claim the id first so concurrent copies apply once; release it unless applied.
  if (!(await db.markProcessed(id, type, via))) return ignored("already applied (another copy)");
  let outcome: Outcome | undefined;
  try {
    outcome = await route(ctx, inbound, type);
    return outcome;
  } finally {
    if (outcome?.kind !== "applied") await sql`delete from processed_activities where id = ${id}`;
  }
}

async function route(ctx: Context<void>, inbound: Inbound, type: string): Promise<Outcome> {
  switch (type) {
    case "Create":
    case "Update":
      return await onCreateOrUpdate(ctx, inbound);
    case "Delete":
      return await onDelete(ctx, inbound);
    case "Like":
    case "Dislike":
      return await onVote(ctx, inbound, type);
    case "Undo":
      return await onUndo(ctx, inbound);
    case "Lock":
      return await onLock(ctx, inbound, inbound.raw, true);
    case "Add":
    case "Remove":
      return await onCollection(ctx, inbound, type === "Add");
    case "Block":
      return await onBlock(ctx, inbound);
    case "Flag":
      return await onFlag(ctx, inbound);
    default:
      return ignored(`${type} not handled`);
  }
}

/** Announces an applied activity to a local community's followers. */
async function relayIfLocal(ctx: Context<void>, inbound: Inbound, community: URL | null): Promise<string> {
  const identifier = localGroup(ctx, community);
  if (inbound.via !== "direct" || !identifier || !(await db.getActor(identifier))) return "";
  await announceRaw(ctx, identifier, inbound.raw, inbound.activity.actorId?.origin);
  return "; announced";
}

// ------------------------------------------------------------------ content

async function communityOf(ctx: Context<void>, object: Page | Note | Article, activity: Activity): Promise<URL | null> {
  // A reply belongs to its parent's community, whatever it claims.
  if (object.replyTargetId) {
    const parent = await db.getObject(object.replyTargetId.href);
    if (parent?.community_uri) return new URL(parent.community_uri);
  }
  const candidates = [object.audienceId, activity.audienceId, ...object.toIds, ...object.ccIds, ...activity.toIds, ...activity.ccIds];
  return candidates.find((uri) => localGroup(ctx, uri) != null) ?? object.audienceId ?? activity.audienceId ?? null;
}

async function firstLink(object: Page | Note | Article): Promise<string | null> {
  for await (const attachment of object.getAttachments()) {
    if (attachment instanceof Link && attachment.href) return attachment.href.href;
  }
  return null;
}

async function onCreateOrUpdate(ctx: Context<void>, inbound: Inbound): Promise<Outcome> {
  const { activity } = inbound;
  const actor = activity.actorId!;
  // Fedify trusts an embedded object only from the activity's origin and
  // otherwise fetches it from its own.
  const object = await activity.getObject(ctx);
  if (!(object instanceof Page || object instanceof Note || object instanceof Article)) {
    return ignored(`object ${object?.constructor.name ?? "null"}`);
  }
  if (!object.id) return rejected("object without id");
  if (object.id.origin !== actor.origin) return rejected(`object ${object.id.href} is not on the author's origin`);
  if (object.attributionId?.href !== actor.href) return rejected("attributedTo does not match actor");
  const existing = await db.getObject(object.id.href);
  const community = existing?.community_uri ? new URL(existing.community_uri) : await communityOf(ctx, object, activity);
  const verdict = await authorize(ctx, {
    actor,
    community,
    owner: existing?.author_uri ?? actor.href,
    allow: ["owner"],
    announcer: inbound.announcer,
  });
  if (!verdict.ok) return rejected(verdict.reason);
  const parentUri = object.replyTargetId?.href ?? null;
  const parent = parentUri ? await db.getObject(parentUri) : undefined;
  // Local communities enforce their bans and locks; remote ones enforce their own.
  if (localGroup(ctx, community)) {
    if (await isBanned(community!, actor)) return rejected(`${actor.href} is banned from ${community!.href}`);
    const root = parent ? await db.getObject(parent.root_uri ?? parent.uri) : undefined;
    if (!existing && root?.locked) return rejected(`post ${root.uri} is locked`);
  }
  const fields = {
    title: object.name?.toString() ?? null,
    content_html: object.content?.toString() ?? "",
    source_md: object.source?.content?.toString() ?? null,
    link_url: await firstLink(object),
    raw: await object.toJsonLd({ format: "compact" }),
  };
  const isCreate = String(inbound.raw.type) === "Create";
  if (existing && isCreate) return ignored(`duplicate ${existing.kind} (first seen ${existing.via})`);
  let outcome: string;
  if (existing) {
    await db.updateObject(object.id.href, fields);
    outcome = `updated ${existing.kind}`;
  } else {
    // Update for an unseen object is treated like Create, as Lemmy does.
    await db.insertObject({
      uri: object.id.href,
      kind: parentUri ? "Note" : "Page",
      local: false,
      author_uri: actor.href,
      community_uri: community?.href ?? null,
      in_reply_to: parentUri,
      root_uri: parentUri ? (parent?.root_uri ?? parentUri) : object.id.href,
      ...fields,
      published: object.published ? new Date(object.published.epochMilliseconds) : new Date(),
      via: inbound.via,
    });
    outcome = `stored ${parentUri ? "Note" : "Page"} in ${community?.href ?? "no community"}`;
  }
  return applied(outcome + (await relayIfLocal(ctx, inbound, community)));
}

async function onDelete(ctx: Context<void>, inbound: Inbound): Promise<Outcome> {
  const { activity, raw } = inbound;
  const actor = activity.actorId!;
  const target = url(raw.object);
  if (!target) return rejected("Delete without object");
  if (target.href === actor.href) return ignored("account deletion not handled");
  const stored = await db.getObject(target.href);
  if (!stored) return ignored("unknown object");
  const community = stored.community_uri ? new URL(stored.community_uri) : null;
  const reason = typeof raw.summary === "string" ? raw.summary : null;
  // Lemmy marks a moderator removal with `summary`; a non-author's Delete is one too.
  const selfDelete = stored.author_uri === actor.href && reason == null;
  const verdict = await authorize(ctx, {
    actor,
    community,
    owner: stored.author_uri,
    allow: selfDelete ? ["owner"] : ["moderator", "community"],
    announcer: inbound.announcer,
  });
  if (!verdict.ok) return rejected(verdict.reason);
  if (selfDelete) await db.markDeleted(stored.uri);
  else await db.setObjectFlag(stored.uri, "removed", true, reason);
  const what = selfDelete ? `deleted ${stored.kind}` : `removed ${stored.kind} as ${verdict.right}`;
  return applied(what + (await relayIfLocal(ctx, inbound, community)));
}

async function onVote(ctx: Context<void>, inbound: Inbound, kind: "Like" | "Dislike"): Promise<Outcome> {
  const { activity, raw } = inbound;
  const actor = activity.actorId!;
  const objectUri = iri(raw.object);
  const target = objectUri ? await db.getObject(objectUri) : undefined;
  if (!target) return ignored("unknown target");
  const community = target.community_uri ? new URL(target.community_uri) : null;
  // A vote is the voter's own; this checks only the announcing community.
  const verdict = await authorize(ctx, { actor, community, owner: actor.href, allow: ["owner"], announcer: inbound.announcer });
  if (!verdict.ok) return rejected(verdict.reason);
  if (localGroup(ctx, community) && (await isBanned(community!, actor))) {
    return rejected(`${actor.href} is banned from ${community!.href}`);
  }
  await db.upsertVote({ voter_uri: actor.href, object_uri: target.uri, kind, activity_id: activity.id!.href, activity: null });
  return applied(`stored vote on ${target.kind}${await relayIfLocal(ctx, inbound, community)}`);
}

// ------------------------------------------------------------------ moderation

async function onLock(ctx: Context<void>, inbound: Inbound, lock: Json, locked: boolean): Promise<Outcome> {
  const actor = inbound.activity.actorId!;
  const objectUri = iri(lock.object);
  const stored = objectUri ? await db.getObject(objectUri) : undefined;
  if (!stored) return ignored("unknown object");
  const community = stored.community_uri ? new URL(stored.community_uri) : null;
  const verdict = await authorize(ctx, {
    actor,
    community,
    owner: stored.author_uri,
    allow: ["moderator", "community"],
    announcer: inbound.announcer,
  });
  if (!verdict.ok) return rejected(verdict.reason);
  await db.setObjectFlag(stored.uri, "locked", locked);
  return applied(`${locked ? "locked" : "unlocked"} ${stored.kind} as ${verdict.right}${await relayIfLocal(ctx, inbound, community)}`);
}

/**
 * Read from the raw Group document: PieFed's minimal @context does not define
 * `featured` (toot:featured), so Fedify's parsed Group drops it.
 */
async function featuredOf(ctx: Context<void>, community: URL): Promise<URL | null> {
  const local = localGroup(ctx, community);
  if (local) return ctx.getFeaturedUri(local);
  const group = await fetchJson(ctx, community);
  const featured = group ? url(group.featured) : null;
  return featured && featured.origin === community.origin ? featured : null;
}

/** The community whose moderators collection `target` is. */
function communityOfModerators(ctx: Context<void>, target: URL, raw: Json): URL | null {
  const parsed = ctx.parseUri(target);
  if (parsed?.type === "collection" && parsed.name === "moderators") {
    const identifier = (parsed.values as Record<string, string>).identifier;
    return identifier ? ctx.getActorUri(identifier) : null;
  }
  const audience = url(raw.audience);
  return audience && target.href.startsWith(`${audience.href}/`) ? audience : null;
}

async function onCollection(ctx: Context<void>, inbound: Inbound, adding: boolean): Promise<Outcome> {
  const { activity, raw } = inbound;
  const actor = activity.actorId!;
  const target = url(raw.target);
  const objectUri = iri(raw.object);
  if (!target || !objectUri) return rejected("Add/Remove without object or target");
  const stored = await db.getObject(objectUri);
  if (stored) {
    // Feature or unfeature a post: the target must be its community's featured collection.
    const community = stored.community_uri ? new URL(stored.community_uri) : null;
    const featured = community ? await featuredOf(ctx, community) : null;
    if (!featured || featured.href !== target.href) {
      return rejected(`${target.href} is not the featured collection of ${community?.href ?? "the post's community"}`);
    }
    const verdict = await authorize(ctx, { actor, community, owner: stored.author_uri, allow: ["moderator", "community"], announcer: inbound.announcer });
    if (!verdict.ok) return rejected(verdict.reason);
    await db.setObjectFlag(stored.uri, "stickied", adding);
    return applied(`${adding ? "featured" : "unfeatured"} ${stored.kind} as ${verdict.right}${await relayIfLocal(ctx, inbound, community)}`);
  }
  // Add or remove a moderator: the target is a community's moderators collection.
  const community = communityOfModerators(ctx, target, raw);
  if (!community) return ignored(`unknown collection ${target.href}`);
  const verdict = await authorize(ctx, { actor, community, allow: ["moderator", "community"], announcer: inbound.announcer });
  if (!verdict.ok) return rejected(verdict.reason);
  const local = localGroup(ctx, community);
  if (local) {
    if (adding) {
      await sql`insert into community_moderators (community_identifier, actor_uri) values (${local}, ${objectUri}) on conflict do nothing`;
    } else {
      await sql`delete from community_moderators where community_identifier = ${local} and actor_uri = ${objectUri}`;
    }
  } else {
    await invalidateRemoteModerators(community);
  }
  return applied(`${adding ? "added" : "removed"} moderator ${objectUri}${await relayIfLocal(ctx, inbound, community)}`);
}

function blockTarget(raw: Json): { community: URL | null; instance: boolean } {
  const target = url(raw.target);
  return { community: target, instance: target != null && target.pathname === "/" };
}

async function onBlock(ctx: Context<void>, inbound: Inbound): Promise<Outcome> {
  const { activity, raw } = inbound;
  const actor = activity.actorId!;
  const banned = iri(raw.object);
  const { community, instance } = blockTarget(raw);
  if (!banned || !community) return rejected("Block without object or target");
  if (instance) return ignored("instance-wide ban not handled");
  const verdict = await authorize(ctx, { actor, community, allow: ["moderator", "community"], announcer: inbound.announcer });
  if (!verdict.ok) return rejected(verdict.reason);
  const expires = typeof raw.expires === "string" ? raw.expires : typeof raw.endTime === "string" ? raw.endTime : null;
  const removeData = raw.removeData === true;
  await sql`
    insert into bans (community_uri, actor_uri, by_actor, reason, expires, remove_data, activity_id)
    values (${community.href}, ${banned}, ${actor.href}, ${typeof raw.summary === "string" ? raw.summary : null},
            ${expires}, ${removeData}, ${activity.id!.href})
    on conflict (community_uri, actor_uri) do update set
      by_actor = excluded.by_actor, reason = excluded.reason, expires = excluded.expires,
      remove_data = excluded.remove_data, activity_id = excluded.activity_id, created_at = now()`;
  let removed = 0;
  if (removeData) {
    const rows = await sql`
      update objects set removed = true, removed_reason = 'removed with ban'
      where author_uri = ${banned} and community_uri = ${community.href} returning 1`;
    removed = rows.length;
  }
  const detail = removeData ? `, removed ${removed} items` : "";
  return applied(`banned ${banned} from ${community.href} as ${verdict.right}${detail}${await relayIfLocal(ctx, inbound, community)}`);
}

async function onFlag(ctx: Context<void>, inbound: Inbound): Promise<Outcome> {
  const { activity, raw } = inbound;
  const objects = (Array.isArray(raw.object) ? raw.object : [raw.object]).map(iri).filter((uri) => uri != null);
  const stored = (await Promise.all(objects.map((uri) => db.getObject(uri)))).filter((row) => row != null);
  const verdict = await authorizeReport(ctx, activity.actorId!, stored);
  if (!verdict.ok) return rejected(verdict.reason);
  const reason = typeof raw.summary === "string" ? raw.summary : typeof raw.content === "string" ? raw.content : null;
  for (const row of stored) {
    await sql`
      insert into reports (activity_id, reporter_uri, object_uri, community_uri, reason)
      values (${`${activity.id!.href}#${row.id}`}, ${activity.actorId!.href}, ${row.uri}, ${row.community_uri}, ${reason})
      on conflict (activity_id) do nothing`;
  }
  return applied(`report on ${stored.map((row) => row.uri).join(", ")} queued for the moderators`);
}

async function onUndo(ctx: Context<void>, inbound: Inbound): Promise<Outcome> {
  const { activity, raw } = inbound;
  const actor = activity.actorId!;
  const innerRaw = await trustedEmbedded(ctx, raw.object, { id: activity.id!, context: raw["@context"] });
  if (!innerRaw) return rejected("could not verify the undone activity from its origin");
  const inner = await parseActivity(ctx, innerRaw);
  if (!inner) return rejected("undone activity does not parse");
  const mismatch = originMismatch(inner.id, inner.actorId);
  if (mismatch) return rejected(`undone activity: ${mismatch}`);
  const innerType = String(innerRaw.type);
  const sameActor = inner.actorId?.href === actor.href;

  switch (innerType) {
    case "Follow": {
      if (!sameActor) return rejected("cannot undo another actor's Follow");
      const target = inner.objectId ? ctx.parseUri(inner.objectId) : null;
      if (target?.type !== "actor") return ignored("Undo(Follow) of a non-local actor");
      await sql`delete from followers where local_identifier = ${target.identifier} and actor_uri = ${actor.href}`;
      return applied(`unfollowed ${target.identifier}`);
    }
    case "Like":
    case "Dislike": {
      if (!sameActor) return rejected("cannot undo another actor's vote");
      // Match on (actor, object): Lemmy regenerates the inner vote's id on Undo.
      const objectUri = iri(innerRaw.object);
      if (!objectUri) return rejected("vote without object");
      const target = await db.getObject(objectUri);
      const community = target?.community_uri ? new URL(target.community_uri) : null;
      const verdict = await authorize(ctx, { actor, community, owner: actor.href, allow: ["owner"], announcer: inbound.announcer });
      if (!verdict.ok) return rejected(verdict.reason);
      const removed = await db.deleteVote(actor.href, objectUri);
      return applied(`${removed ? "removed" : "no stored"} vote on ${objectUri}${await relayIfLocal(ctx, inbound, community)}`);
    }
    case "Delete": {
      const objectUri = iri(innerRaw.object);
      const stored = objectUri ? await db.getObject(objectUri) : undefined;
      if (!stored) return ignored("unknown object");
      const community = stored.community_uri ? new URL(stored.community_uri) : null;
      const wasRemoval = typeof innerRaw.summary === "string" || stored.author_uri !== inner.actorId?.href;
      const verdict = await authorize(ctx, {
        actor,
        community,
        owner: stored.author_uri,
        allow: wasRemoval ? ["moderator", "community"] : ["owner"],
        announcer: inbound.announcer,
      });
      if (!verdict.ok) return rejected(verdict.reason);
      await db.setObjectFlag(stored.uri, wasRemoval ? "removed" : "deleted", false);
      const what = wasRemoval ? `restored ${stored.kind} as ${verdict.right}` : `undeleted ${stored.kind}`;
      return applied(what + (await relayIfLocal(ctx, inbound, community)));
    }
    case "Lock":
      return await onLock(ctx, inbound, innerRaw, false);
    case "Block": {
      const banned = iri(innerRaw.object);
      const { community, instance } = blockTarget(innerRaw);
      if (!banned || !community) return rejected("Undo(Block) without object or target");
      if (instance) return ignored("instance-wide unban not handled");
      const verdict = await authorize(ctx, { actor, community, allow: ["moderator", "community"], announcer: inbound.announcer });
      if (!verdict.ok) return rejected(verdict.reason);
      const rows = await sql`delete from bans where community_uri = ${community.href} and actor_uri = ${banned} returning 1`;
      return applied(`${rows.length > 0 ? "unbanned" : "no stored ban for"} ${banned} in ${community.href}${await relayIfLocal(ctx, inbound, community)}`);
    }
    default:
      return ignored(`Undo(${innerType}) not handled`);
  }
}

// ------------------------------------------------------------------ Announce

async function onAnnounce(ctx: Context<void>, announce: Announce): Promise<Outcome | null> {
  const announcer = announce.actorId;
  const mismatch = originMismatch(announce.id, announcer);
  if (mismatch) return rejected(mismatch);
  const [followed] = await sql`select 1 from following where remote_uri = ${announcer!.href} and accepted`;
  if (!followed) return rejected("Announce from a group nobody here follows");
  const objectId = announce.objectId;
  if (!objectId) return rejected("Announce without object");
  // Lemmy relays our users' activities back to us: skip them by origin, before
  // any fetch, and skip ids already applied from another copy.
  if (objectId.origin === ctx.canonicalOrigin) return ignored("echo of our own activity");
  const [done] = await sql`select 1 from processed_activities where id = ${objectId.href}`;
  if (done) return ignored("already applied (another copy)");
  const raw = (await announce.toJsonLd()) as Json;
  const inner = await trustedEmbedded(ctx, raw.object, { id: announce.id!, context: raw["@context"] });
  if (!inner) return rejected(`could not verify ${objectId.href} from its origin`);
  const innerType = String(inner.type);
  // Lemmy also sends Announce(Page) copies for microblog software.
  if (!HANDLED.has(innerType)) return ignored(`Announce(${innerType}) is not an activity handled here`);
  const activity = await parseActivity(ctx, inner);
  if (!activity) return rejected(`announced ${innerType} does not parse`);
  await record(announce, "direct", `unwrapping ${innerType} ${activity.id?.href}`, raw);
  await handle(ctx, { activity, raw: inner, via: "announce", announcer: announcer! });
  return null;
}

// ------------------------------------------------------------------ follow answers

/**
 * Marks a pending follow accepted. Only a row that exists, is still pending and
 * carries both this Follow id and this community as its remote actor changes: a
 * late or repeated Accept (after we sent Undo(Follow), say) never creates or
 * revives a follow.
 */
export async function acceptFollow(followId: string, communityUri: string): Promise<boolean> {
  const rows = await sql`
    update following set accepted = true
    where follow_id = ${followId} and remote_uri = ${communityUri} and not accepted returning 1`;
  return rows.length > 0;
}

/** Drops the follow a community refused or ended; the Reject must come from the followed actor. */
export async function rejectFollow(followId: string, communityUri: string): Promise<boolean> {
  const rows = await sql`
    delete from following where follow_id = ${followId} and remote_uri = ${communityUri} returning 1`;
  return rows.length > 0;
}

// ------------------------------------------------------------------ listeners

federation
  .setInboxListeners("/ap/{identifier}/inbox", "/inbox")
  .on(Follow, async (ctx, follow) => {
    if (!follow.id || !follow.actorId || !follow.objectId) return await record(follow, "direct", "rejected: missing fields");
    const target = ctx.parseUri(follow.objectId);
    if (target?.type !== "actor" || !(await db.getActor(target.identifier))) {
      return await record(follow, "direct", "ignored: unknown local actor");
    }
    const follower = await follow.getActor(ctx);
    if (!follower?.id || !follower.inboxId) return await record(follow, "direct", "rejected: could not resolve follower");
    await sql`
      insert into followers (local_identifier, actor_uri, inbox, shared_inbox, follow_id)
      values (${target.identifier}, ${follower.id.href}, ${follower.inboxId.href},
              ${follower.endpoints?.sharedInbox?.href ?? null}, ${follow.id.href})
      on conflict (local_identifier, actor_uri) do update
        set inbox = excluded.inbox, shared_inbox = excluded.shared_inbox, follow_id = excluded.follow_id`;
    // Lemmy's parser needs the nested Follow trimmed to id, actor and object.
    const accept = new Accept({
      id: newActivityUri("Accept"),
      actor: follow.objectId,
      to: follow.actorId,
      object: new Follow({ id: follow.id, actor: follow.actorId, object: follow.objectId }),
    });
    await enqueue(target.identifier, accept, [follower.inboxId]);
    await record(follow, "direct", `accepted follower of ${target.identifier}`);
  })
  .on(Accept, async (_ctx, accept) => {
    if (!accept.actorId || !accept.objectId) return await record(accept, "direct", "rejected: missing fields");
    // Match on the Follow id: the embedded Follow is ours (cross-origin), so
    // Fedify would try to re-fetch it from us rather than trust the copy.
    const matched = await acceptFollow(accept.objectId.href, accept.actorId.href);
    await record(accept, "direct", matched ? "follow accepted" : "ignored: accept for unknown follow");
  })
  .on(Reject, async (_ctx, reject) => {
    if (!reject.actorId || !reject.objectId) return await record(reject, "direct", "rejected: missing fields");
    const matched = await rejectFollow(reject.objectId.href, reject.actorId.href);
    await record(reject, "direct", matched ? "follow rejected" : "ignored: reject for unknown follow");
  })
  .on(Announce, async (ctx, announce) => {
    const outcome = await onAnnounce(ctx, announce);
    if (outcome) await record(announce, "direct", outcome.text, (await announce.toJsonLd()) as Json);
  })
  // Everything else, including Lock, which Fedify parses as a plain Activity.
  .on(Activity, async (ctx, activity) => {
    const raw = (await activity.toJsonLd()) as Json;
    await handle(ctx, { activity, raw, via: "direct", announcer: null });
  })
  .onError((_ctx, error) => {
    capture("rejected", { outcome: "listener error", error: String(error) });
  });
