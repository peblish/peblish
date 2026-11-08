// Outbound operations behind the /spike control surface. Each one stores the
// local change, then federates it: through the local community's Announce
// fan-out, or straight to a remote community's inbox.
import type { Context } from "@fedify/fedify";
import {
  type Activity,
  Add,
  Block,
  Delete,
  Dislike,
  Follow,
  isActor,
  Like,
  Note,
  Page,
  PUBLIC_COLLECTION,
  Remove,
  Undo,
} from "@fedify/vocab";
import { isBanned } from "./authz.ts";
import {
  createFor,
  deleteFor,
  localObjectUri,
  markdownToHtml,
  newActivityUri,
  toVocab,
  updateFor,
} from "./content.ts";
import * as db from "./db.ts";
import { sql } from "./db.ts";
import { contextForBackground, localGroup, stableCreateId } from "./federation.ts";
import { enqueue } from "./outbox.ts";
import { announceLocal, announceRaw } from "./relay.ts";

export class ActionError extends Error {}

function userIdentifier(name: string): string {
  return name.startsWith("u.") ? name : `u.${name}`;
}

async function requireLocalUser(name: string): Promise<string> {
  const identifier = userIdentifier(name);
  const actor = await db.getActor(identifier);
  if (actor?.kind !== "Person") throw new ActionError(`unknown local user ${name}`);
  return identifier;
}

/** Accepts a local slug ("spike"), a handle ("!lab@lemmy.lab.test") or a URL. */
async function resolveCommunity(ctx: Context<void>, community: string): Promise<URL> {
  if (/^[a-z0-9_]+$/i.test(community)) {
    const identifier = `c.${community}`;
    if (!(await db.getActor(identifier))) throw new ActionError(`unknown local community ${community}`);
    return ctx.getActorUri(identifier);
  }
  const handle = community.startsWith("!") ? `@${community.slice(1)}` : community;
  const group = await ctx.lookupObject(handle);
  if (!isActor(group) || !group.id) throw new ActionError(`could not resolve ${community}`);
  return group.id;
}

async function deliver(
  ctx: Context<void>,
  senderIdentifier: string,
  community: URL,
  activity: Activity,
): Promise<void> {
  const local = localGroup(ctx, community);
  if (local) return await announceLocal(ctx, local, activity);
  await enqueue(senderIdentifier, activity, [await inboxOf(ctx, community)]);
}

/** Local users obey bans too, including bans a remote community sent us. */
async function requireNotBanned(community: URL, author: URL): Promise<void> {
  if (await isBanned(community, author)) throw new ActionError(`${author.href} is banned from ${community.href}`);
}

/** A remote actor's shared inbox, or its own. */
async function inboxOf(ctx: Context<void>, actorUri: URL): Promise<URL> {
  const actor = await ctx.lookupObject(actorUri);
  if (!isActor(actor)) throw new ActionError(`${actorUri.href} is not an actor`);
  const inbox = actor.endpoints?.sharedInbox ?? actor.inboxId;
  if (!inbox) throw new ActionError(`${actorUri.href} has no inbox`);
  return inbox;
}

/** A local user name ("alice") or an actor URI, as an actor URI. */
function actorUri(ctx: Context<void>, nameOrUri: string): URL {
  return /^https?:\/\//.test(nameOrUri) ? new URL(nameOrUri) : ctx.getActorUri(userIdentifier(nameOrUri));
}

export async function createActor(input: {
  kind: "Person" | "Group";
  name: string;
  displayName?: string;
  summary?: string;
  moderators?: string[];
}) {
  const ctx = contextForBackground();
  const actor = await db.createActor(input.kind, input.name, input.displayName ?? input.name, input.summary ?? "");
  for (const moderator of input.moderators ?? []) {
    await sql`
      insert into community_moderators (community_identifier, actor_uri)
      values (${actor.identifier}, ${actorUri(ctx, moderator).href}) on conflict do nothing`;
  }
  return { identifier: actor.identifier, uri: ctx.getActorUri(actor.identifier).href };
}

/**
 * Adds or removes a moderator of a local community (a local user or a remote
 * actor) and tells the followers with Add/Remove on the moderators
 * collection, which Lemmy and PieFed apply to their copy of the list.
 */
export async function setModerator(input: { community: string; actor: string; by: string; remove?: boolean }) {
  const ctx = contextForBackground();
  const community = `c.${input.community}`;
  if (!(await db.getActor(community))) throw new ActionError(`unknown local community ${input.community}`);
  const by = ctx.getActorUri(await requireLocalUser(input.by));
  const [isMod] = await sql`
    select 1 from community_moderators where community_identifier = ${community} and actor_uri = ${by.href}`;
  if (!isMod) throw new ActionError(`${input.by} does not moderate ${community}`);
  const target = actorUri(ctx, input.actor);
  if (input.remove) {
    await sql`delete from community_moderators where community_identifier = ${community} and actor_uri = ${target.href}`;
  } else {
    await sql`
      insert into community_moderators (community_identifier, actor_uri)
      values (${community}, ${target.href}) on conflict do nothing`;
  }
  const communityUri = ctx.getActorUri(community);
  const values = {
    actor: by,
    object: target,
    target: ctx.getCollectionUri("moderators", { identifier: community }),
    tos: [PUBLIC_COLLECTION],
    ccs: [communityUri],
    audience: communityUri,
  };
  const activity = input.remove
    ? new Remove({ id: newActivityUri("Remove"), ...values })
    : new Add({ id: newActivityUri("Add"), ...values });
  await announceLocal(ctx, community, activity);
  return { activity: activity.id?.href, json: await activity.toJsonLd({ format: "compact" }) };
}

export async function createPost(input: {
  author: string;
  community: string;
  title: string;
  body: string;
  link?: string;
}) {
  const ctx = contextForBackground();
  const author = await requireLocalUser(input.author);
  const community = await resolveCommunity(ctx, input.community);
  await requireNotBanned(community, ctx.getActorUri(author));
  const id = await db.nextObjectId();
  const uri = localObjectUri("Page", id).href;
  const { row } = await db.insertObject({
    id,
    uri,
    kind: "Page",
    local: true,
    author_uri: ctx.getActorUri(author).href,
    community_uri: community.href,
    in_reply_to: null,
    root_uri: uri,
    title: input.title,
    content_html: markdownToHtml(input.body),
    source_md: input.body,
    link_url: input.link ?? null,
    via: "local",
  });
  const page = toVocab(row);
  if (!(page instanceof Page)) throw new ActionError("internal: expected a Page");
  const create = createFor(ctx.getActorUri(author), page, community, stableCreateId(id));
  await deliver(ctx, author, community, create);
  return { uri, activity: create.id?.href, json: await create.toJsonLd({ format: "compact" }) };
}

export async function createComment(input: { author: string; inReplyTo: string; body: string }) {
  const ctx = contextForBackground();
  const author = await requireLocalUser(input.author);
  const parent = await db.getObject(input.inReplyTo);
  if (!parent?.community_uri) throw new ActionError(`unknown parent ${input.inReplyTo}`);
  const community = new URL(parent.community_uri);
  await requireNotBanned(community, ctx.getActorUri(author));
  const id = await db.nextObjectId();
  const uri = localObjectUri("Note", id).href;
  const { row } = await db.insertObject({
    id,
    uri,
    kind: "Note",
    local: true,
    author_uri: ctx.getActorUri(author).href,
    community_uri: community.href,
    in_reply_to: parent.uri,
    root_uri: parent.root_uri ?? parent.uri,
    title: null,
    content_html: markdownToHtml(input.body),
    source_md: input.body,
    link_url: null,
    via: "local",
  });
  const note = toVocab(row);
  if (!(note instanceof Note)) throw new ActionError("internal: expected a Note");
  const create = createFor(ctx.getActorUri(author), note, community, stableCreateId(id));
  await deliver(ctx, author, community, create);
  return { uri, activity: create.id?.href, json: await create.toJsonLd({ format: "compact" }) };
}

export async function vote(input: { voter: string; object: string; kind: "Like" | "Dislike" | "Undo" }) {
  const ctx = contextForBackground();
  const voter = await requireLocalUser(input.voter);
  const voterUri = ctx.getActorUri(voter);
  const target = await db.getObject(input.object);
  if (!target?.community_uri) throw new ActionError(`unknown object ${input.object}`);
  const community = new URL(target.community_uri);

  if (input.kind === "Undo") {
    const stored = await db.getVote(voterUri.href, target.uri);
    if (!stored?.activity) throw new ActionError("no vote to undo");
    // Undo embeds the original vote, as Lemmy's UndoVote parser requires.
    const original = stored.kind === "Like"
      ? await Like.fromJsonLd(stored.activity)
      : await Dislike.fromJsonLd(stored.activity);
    const undo = new Undo({ id: newActivityUri("Undo"), actor: voterUri, object: original, audience: community });
    await db.deleteVote(voterUri.href, target.uri);
    await deliver(ctx, voter, community, undo);
    return { activity: undo.id?.href, json: await undo.toJsonLd({ format: "compact" }) };
  }

  const values = { id: newActivityUri(input.kind), actor: voterUri, object: new URL(target.uri), audience: community };
  const activity = input.kind === "Like" ? new Like(values) : new Dislike(values);
  const json = await activity.toJsonLd({ format: "compact" });
  await db.upsertVote({
    voter_uri: voterUri.href,
    object_uri: target.uri,
    kind: input.kind,
    activity_id: values.id.href,
    activity: json,
  });
  await deliver(ctx, voter, community, activity);
  return { activity: values.id.href, json };
}

async function requireLocalObject(uri: string) {
  const row = await db.getObject(uri);
  if (!row?.local || !row.community_uri) throw new ActionError(`not a local object: ${uri}`);
  return row;
}

export async function edit(input: { object: string; title?: string; body: string }) {
  const ctx = contextForBackground();
  const row = await requireLocalObject(input.object);
  const updated = await db.updateObject(row.uri, {
    title: input.title ?? null,
    content_html: markdownToHtml(input.body),
    source_md: input.body,
  });
  const object = updated && toVocab(updated);
  if (!(object instanceof Page || object instanceof Note)) throw new ActionError("cannot edit a deleted object");
  const author = new URL(row.author_uri);
  const update = updateFor(author, object, new URL(row.community_uri!));
  const sender = ctx.parseUri(author);
  if (sender?.type !== "actor") throw new ActionError("author is not local");
  await deliver(ctx, sender.identifier, new URL(row.community_uri!), update);
  return { activity: update.id?.href, json: await update.toJsonLd({ format: "compact" }) };
}

export async function remove(input: { object: string }) {
  const ctx = contextForBackground();
  const row = await requireLocalObject(input.object);
  await db.markDeleted(row.uri);
  const author = new URL(row.author_uri);
  const del = deleteFor(author, new URL(row.uri), new URL(row.community_uri!));
  const sender = ctx.parseUri(author);
  if (sender?.type !== "actor") throw new ActionError("author is not local");
  await deliver(ctx, sender.identifier, new URL(row.community_uri!), del);
  return { activity: del.id?.href, json: await del.toJsonLd({ format: "compact" }) };
}

export type ModAction = "remove" | "restore" | "lock" | "unlock" | "feature" | "unfeature" | "ban" | "unban";

/**
 * Slice 2 probe: a moderator of a local community acts on content or a person
 * there, and the community announces it. Shapes follow Lemmy 0.19: Delete with
 * `summary` (mod removal), Lock, Add/Remove with `target` = featured, Block
 * with `target` = community, each undone by an Undo embedding the original.
 */
export async function moderate(input: {
  moderator: string;
  action: ModAction;
  object: string;
  community?: string;
  reason?: string;
}) {
  const ctx = contextForBackground();
  const moderator = await requireLocalUser(input.moderator);
  const modUri = ctx.getActorUri(moderator);
  const target = input.action === "ban" || input.action === "unban" ? undefined : await db.getObject(input.object);
  const communityUri = target?.community_uri
    ? new URL(target.community_uri)
    : input.community ? await resolveCommunity(ctx, input.community) : null;
  const community = localGroup(ctx, communityUri);
  if (!communityUri || !community) throw new ActionError("moderation needs a local community");
  const [isMod] = await sql`
    select 1 from community_moderators where community_identifier = ${community} and actor_uri = ${modUri.href}`;
  if (!isMod) throw new ActionError(`${input.moderator} does not moderate ${community}`);

  const common = { actor: modUri, tos: [PUBLIC_COLLECTION], ccs: [communityUri], audience: communityUri };
  const objectUri = new URL(input.object);
  // Remembered under the action's own name (remove, lock, feature, ban) for its Undo.
  const key = `${input.action}:${community}:${input.object}`;
  const stored = async (name: string) => {
    const [row] = await sql<{ activity: Record<string, unknown> }[]>`
      select activity from mod_actions where key = ${`${name}:${community}:${input.object}`}`;
    if (!row) throw new ActionError(`nothing to undo for ${name}`);
    return row.activity;
  };
  const remember = async (json: unknown) => {
    await sql`
      insert into mod_actions (key, activity) values (${key}, ${sql.json(json as never)})
      on conflict (key) do update set activity = excluded.activity`;
  };
  const setFlag = async (column: "removed" | "locked" | "stickied", value: boolean) => {
    await sql`update objects set ${sql(column)} = ${value} where uri = ${input.object}`;
  };

  let activity: Activity | undefined;
  let raw: Record<string, unknown> | undefined;
  switch (input.action) {
    case "remove":
      activity = new Delete({ id: newActivityUri("Delete"), object: objectUri, summary: input.reason ?? "Removed by a moderator", ...common });
      await setFlag("removed", true);
      break;
    case "restore":
      activity = new Undo({ id: newActivityUri("Undo"), object: await Delete.fromJsonLd(await stored("remove")), ...common });
      await setFlag("removed", false);
      break;
    case "feature":
      activity = new Add({ id: newActivityUri("Add"), object: objectUri, target: ctx.getFeaturedUri(community), ...common });
      await setFlag("stickied", true);
      break;
    case "unfeature":
      activity = new Remove({ id: newActivityUri("Remove"), object: objectUri, target: ctx.getFeaturedUri(community), ...common });
      await setFlag("stickied", false);
      break;
    case "ban":
      activity = new Block({ id: newActivityUri("Block"), object: objectUri, target: communityUri, summary: input.reason ?? "Banned by a moderator", ...common });
      // Enforced on inbound content (inbox.ts) and on local authors (requireNotBanned).
      await sql`
        insert into bans (community_uri, actor_uri, by_actor, reason, activity_id)
        values (${communityUri.href}, ${objectUri.href}, ${modUri.href}, ${input.reason ?? null}, ${activity.id!.href})
        on conflict (community_uri, actor_uri) do update set
          by_actor = excluded.by_actor, reason = excluded.reason, activity_id = excluded.activity_id, created_at = now()`;
      break;
    case "unban":
      activity = new Undo({ id: newActivityUri("Undo"), object: await Block.fromJsonLd(await stored("ban")), ...common });
      await sql`delete from bans where community_uri = ${communityUri.href} and actor_uri = ${objectUri.href}`;
      break;
    case "lock":
    case "unlock": {
      // Fedify's vocabulary has no Lock, so this one is plain JSON.
      const envelope = {
        actor: modUri.href,
        to: [PUBLIC_COLLECTION.href],
        cc: [communityUri.href],
        audience: communityUri.href,
      };
      const lock = { id: newActivityUri("Lock").href, type: "Lock", object: input.object, ...envelope };
      raw = input.action === "lock"
        ? { "@context": "https://www.w3.org/ns/activitystreams", ...lock }
        : { "@context": "https://www.w3.org/ns/activitystreams", id: newActivityUri("Undo").href, type: "Undo", object: await stored("lock"), ...envelope };
      await setFlag("locked", input.action === "lock");
      break;
    }
  }

  if (activity) {
    const json = await activity.toJsonLd({ format: "compact" });
    if (!input.action.startsWith("un") && input.action !== "restore") await remember(json);
    await announceLocal(ctx, community, activity);
    return { activity: activity.id?.href, json };
  }
  if (input.action === "lock") {
    const { "@context": _context, ...lock } = raw!;
    await remember(lock);
  }
  await announceRaw(ctx, community, raw!);
  return { activity: raw?.id, json: raw };
}

export async function follow(input: { follower: string; target: string }) {
  const ctx = contextForBackground();
  const follower = await requireLocalUser(input.follower);
  const groupUri = await resolveCommunity(ctx, input.target);
  const group = await ctx.lookupObject(groupUri);
  if (!isActor(group) || !group.id) throw new ActionError(`could not resolve ${input.target}`);
  const activity = new Follow({
    id: newActivityUri("Follow"),
    actor: ctx.getActorUri(follower),
    object: group.id,
    to: group.id,
  });
  await sql`
    insert into following (local_identifier, remote_uri, follow_id)
    values (${follower}, ${group.id.href}, ${activity.id!.href})
    on conflict (local_identifier, remote_uri) do update set follow_id = excluded.follow_id, accepted = false`;
  await enqueue(follower, activity, [await inboxOf(ctx, group.id)]);
  return { remote: group.id.href, activity: activity.id?.href, json: await activity.toJsonLd({ format: "compact" }) };
}

/**
 * Leaves a remote community: Undo(Follow) embedding the stored Follow, sent to
 * the community's inbox, then the local row is forgotten. Sent before the
 * delete, so a failed inbox lookup leaves the follow in place to retry.
 */
export async function unfollow(input: { follower: string; target: string }) {
  const ctx = contextForBackground();
  const follower = await requireLocalUser(input.follower);
  const groupUri = await resolveCommunity(ctx, input.target);
  const [row] = await sql<{ follow_id: string }[]>`
    select follow_id from following
    where local_identifier = ${follower} and remote_uri = ${groupUri.href}`;
  if (!row) throw new ActionError(`${input.follower} does not follow ${input.target}`);
  const actor = ctx.getActorUri(follower);
  const undo = new Undo({
    id: newActivityUri("Undo"),
    actor,
    object: new Follow({ id: new URL(row.follow_id), actor, object: groupUri, to: groupUri }),
    to: groupUri,
  });
  await enqueue(follower, undo, [await inboxOf(ctx, groupUri)]);
  await sql`delete from following where local_identifier = ${follower} and remote_uri = ${groupUri.href}`;
  return { remote: groupUri.href, activity: undo.id?.href, json: await undo.toJsonLd({ format: "compact" }) };
}
