import { createHash, timingSafeEqual } from "node:crypto";
import { federation as fedifyMiddleware } from "@fedify/hono";
import { Hono } from "hono";
import * as actions from "./actions.ts";
import { capture, MAX_BODY_BYTES, parseMaybeJson, pickHeaders } from "./capture.ts";
import { CONTROL_TOKEN, ORIGIN, SOFTWARE } from "./config.ts";
import * as db from "./db.ts";
import { sql } from "./db.ts";
import { buildNodeInfo, contextForBackground, federation } from "./federation.ts";
import { instanceActor } from "./instance.ts";
import { isHeld, outboxRows, outboxSnapshot, setHold } from "./outbox.ts";

export const app = new Hono();

// ------------------------------------------------------------------ raw inbound capture

// Only the real inboxes (the shared one and one per actor) are read and
// captured: this runs before any authentication, so any other path ending in
// /inbox must stay out of it.
const INBOX_PATH = /^\/(ap\/[^/]+\/)?inbox$/;

/**
 * The body as text, or null once it passes `limit` bytes. Content-Length is only
 * a shortcut: a chunked body has none, so the stream is counted as it is read.
 */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      // Not awaited: a tee's cancel settles only when both branches are cancelled.
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

app.use(async (c, next) => {
  if (c.req.method !== "POST" || !INBOX_PATH.test(c.req.path)) return await next();
  // The clone is read here; the original stays whole for Fedify.
  const text = await readLimited(c.req.raw.clone(), MAX_BODY_BYTES);
  if (text === null) return c.json({ error: "payload too large" }, 413, { connection: "close" });
  await next();
  capture("inbound", {
    path: c.req.path,
    status: c.res.status,
    headers: pickHeaders(c.req.raw.headers),
    body: parseMaybeJson(text),
  });
});

// ------------------------------------------------------------------ NodeInfo

// Fedify advertises only the 2.1 rel; PieFed also looks for 2.0, so we serve both.
const NODEINFO_20 = "http://nodeinfo.diaspora.software/ns/schema/2.0";
const NODEINFO_21 = "http://nodeinfo.diaspora.software/ns/schema/2.1";

app.get("/.well-known/nodeinfo", (c) =>
  c.json({
    links: [
      { rel: NODEINFO_20, href: new URL("/nodeinfo/2.0", ORIGIN).href },
      { rel: NODEINFO_21, href: new URL("/nodeinfo/2.1", ORIGIN).href },
    ],
  }),
);

app.get("/nodeinfo/2.0", async (c) => {
  const info = await buildNodeInfo();
  c.header("content-type", `application/json; profile="${NODEINFO_20}#"`);
  return c.body(
    JSON.stringify({
      version: "2.0",
      software: { name: SOFTWARE.name, version: SOFTWARE.version },
      protocols: info.protocols,
      services: { inbound: [], outbound: [] },
      openRegistrations: info.openRegistrations,
      usage: info.usage,
      metadata: info.metadata ?? {},
    }),
  );
});

// ------------------------------------------------------------------ Lemmy terms on Group documents

// Fedify's vocabulary cannot carry Lemmy-only properties, so they are added to
// the served (unsigned) Group JSON. Signed outbound activities cannot be
// patched this way; see RESULT.md.
const LEMMY_CONTEXT = {
  lemmy: "https://join-lemmy.org/ns#",
  postingRestrictedToMods: "lemmy:postingRestrictedToMods",
  stickied: "lemmy:stickied",
  removeData: "lemmy:removeData",
  distinguished: "lemmy:distinguished",
  moderators: { "@type": "@id", "@id": "lemmy:moderators" },
};

app.use(async (c, next) => {
  await next();
  const type = c.res.headers.get("content-type") ?? "";
  if (c.res.status !== 200 || !type.includes("json")) return;
  const isGroup = /^\/ap\/c\.[^/]+$/.test(c.req.path);
  const isModerators = /^\/ap\/c\.[^/]+\/moderators$/.test(c.req.path);
  if (!isGroup && !isModerators) return;
  const json = (await c.res.json()) as Record<string, unknown>;
  if (isGroup) {
    const context = json["@context"];
    json["@context"] = [...(Array.isArray(context) ? context : [context]), LEMMY_CONTEXT];
    json.postingRestrictedToMods = false;
    json.moderators = new URL(`${c.req.path}/moderators`, ORIGIN).href;
  } else if (Array.isArray(json.orderedItems)) {
    // Fedify embeds each Person; Lemmy's GroupModerators wants actor IRIs.
    json.orderedItems = json.orderedItems.map((item: unknown) =>
      typeof item === "object" && item != null && "id" in item ? item.id : item,
    );
  }
  c.res = new Response(JSON.stringify(json), { status: 200, headers: { "content-type": type } });
});

// ------------------------------------------------------------------ federation

app.use(fedifyMiddleware(federation, () => undefined));

// ------------------------------------------------------------------ control surface

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") throw new actions.ActionError(`"${key}" is required`);
  return value;
}

function optionalField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

const spike = new Hono();
spike.onError((error, c) =>
  c.json({ error: error.message }, error instanceof actions.ActionError ? 400 : 500),
);

// A public deployment sets FEDDIT_CONTROL_TOKEN; the lab does not. Both sides
// are hashed first, so timingSafeEqual gets equal-length buffers and the
// token's length does not leak.
if (CONTROL_TOKEN) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(CONTROL_TOKEN);
  spike.use(async (c, next) => {
    const presented = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    if (!timingSafeEqual(digest(presented), expected)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
}

spike.post("/actors", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const kind = field(body, "kind");
  if (kind !== "Person" && kind !== "Group") throw new actions.ActionError(`bad kind ${kind}`);
  const moderators = Array.isArray(body.moderators) ? body.moderators.map(String) : [];
  return c.json(
    await actions.createActor({
      kind,
      name: field(body, "name"),
      displayName: optionalField(body, "displayName"),
      summary: optionalField(body, "summary"),
      moderators,
    }),
  );
});

spike.post("/post", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return c.json(
    await actions.createPost({
      author: field(body, "author"),
      community: field(body, "community"),
      title: field(body, "title"),
      body: field(body, "body"),
      link: optionalField(body, "link"),
    }),
  );
});

// Mastodon compatibility: Announce(Page) to the followers at the named origins only.
spike.post("/announce-page", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const origins = Array.isArray(body.origins) ? body.origins.filter((v): v is string => typeof v === "string") : [];
  return c.json(await actions.announcePage({ object: field(body, "object"), origins }));
});

spike.post("/comment", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return c.json(
    await actions.createComment({
      author: field(body, "author"),
      inReplyTo: field(body, "inReplyTo"),
      body: field(body, "body"),
    }),
  );
});

spike.post("/vote", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const kind = field(body, "kind");
  if (kind !== "Like" && kind !== "Dislike" && kind !== "Undo") throw new actions.ActionError(`bad kind ${kind}`);
  return c.json(await actions.vote({ voter: field(body, "voter"), object: field(body, "object"), kind }));
});

spike.post("/edit", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return c.json(
    await actions.edit({
      object: field(body, "object"),
      title: optionalField(body, "title"),
      body: field(body, "body"),
    }),
  );
});

spike.post("/delete", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return c.json(await actions.remove({ object: field(body, "object") }));
});

const MOD_ACTIONS = ["remove", "restore", "lock", "unlock", "feature", "unfeature", "ban", "unban"] as const;
const isModAction = (value: string): value is actions.ModAction =>
  (MOD_ACTIONS as readonly string[]).includes(value);

spike.post("/moderate", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const action = field(body, "action");
  if (!isModAction(action)) throw new actions.ActionError(`bad action ${action}`);
  return c.json(
    await actions.moderate({
      moderator: field(body, "moderator"),
      action,
      object: field(body, "object"),
      community: optionalField(body, "community"),
      reason: optionalField(body, "reason"),
    }),
  );
});

spike.post("/follow", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return c.json(await actions.follow({ follower: field(body, "follower"), target: field(body, "target") }));
});

spike.post("/unfollow", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return c.json(await actions.unfollow({ follower: field(body, "follower"), target: field(body, "target") }));
});

spike.post("/moderators", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  return c.json(
    await actions.setModerator({
      community: field(body, "community"),
      actor: field(body, "actor"),
      by: field(body, "by"),
      remove: body.remove === true,
    }),
  );
});

// Lab control for the restart scenario: hold the outbox so rows stay pending.
spike.post("/outbox/hold", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  setHold(body.hold === true);
  return c.json({ held: isHeld() });
});

spike.get("/outbox", async (c) => c.json(await outboxRows(c.req.query("object") ?? "")));

// Everything the scenarios assert on, in one read.
spike.get("/state", async (c) => {
  const since = Number(c.req.query("since") ?? 0);
  const [actors, objects, votes, followers, following, inbox, moderators, bans, reports, outbox] = await Promise.all([
    sql`select identifier, kind, name, display_name from actors order by created_at`,
    sql`select id, uri, kind, local, author_uri, community_uri, in_reply_to, root_uri, title,
               content_html, source_md, link_url, deleted, removed, removed_reason, locked, stickied, via, updated
        from objects order by id`,
    sql`select voter_uri, object_uri, kind, activity_id from votes order by created_at`,
    sql`select local_identifier, actor_uri, inbox, shared_inbox from followers order by created_at`,
    sql`select local_identifier, remote_uri, follow_id, accepted from following order by created_at`,
    sql`select * from inbox_log where id > ${since} order by id`,
    sql`select community_identifier, actor_uri from community_moderators order by added_at`,
    sql`select community_uri, actor_uri, by_actor, reason, expires, remove_data, activity_id from bans order by created_at`,
    sql`select activity_id, reporter_uri, object_uri, community_uri, reason from reports order by id`,
    outboxSnapshot(200),
  ]);
  return c.json({ actors, objects, votes, followers, following, inbox, moderators, bans, reports, outbox });
});

app.route("/spike", spike);

// ------------------------------------------------------------------ human pages (the actors' `url`)

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font:15px system-ui;max-width:44rem;margin:2rem auto">${body}</body>`;

const wantsActivityJson = (accept: string | undefined) =>
  /application\/(activity|ld)\+json/.test(accept ?? "");

// A pasted /c/name or /u/name URL is answered with the actor document, without
// a redirect (PieFed's fetcher does not follow redirects).
async function actorDocument(request: Request, identifier: string): Promise<Response> {
  return await federation.fetch(
    new Request(new URL(`/ap/${identifier}`, ORIGIN), { headers: request.headers }),
    { contextData: undefined },
  );
}

app.get("/c/:name", async (c) => {
  const identifier = `c.${c.req.param("name")}`;
  if (wantsActivityJson(c.req.header("accept"))) return await actorDocument(c.req.raw, identifier);
  const actor = await db.getActor(identifier);
  if (!actor) return c.notFound();
  const posts = await db.listCommunityPosts(new URL(`/ap/${identifier}`, ORIGIN).href, 50);
  const items = posts
    .map((p) => `<li><a href="${escape(p.uri)}">${escape(p.title ?? "(untitled)")}</a> by ${escape(p.author_uri)}</li>`)
    .join("");
  return c.html(page(actor.display_name, `<h1>!${escape(actor.name)}@${ORIGIN.host}</h1><ul>${items}</ul>`));
});

app.get("/u/:name", async (c) => {
  const identifier = `u.${c.req.param("name")}`;
  if (wantsActivityJson(c.req.header("accept"))) return await actorDocument(c.req.raw, identifier);
  const actor = await db.getActor(identifier);
  if (!actor) return c.notFound();
  return c.html(page(actor.display_name, `<h1>@${escape(actor.name)}@${ORIGIN.host}</h1>`));
});

// S9 link-post target inside the lab, so peers' link-metadata fetches succeed.
app.get("/link-target", (c) =>
  c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>peblish federation lab link target</title>` +
      `<meta property="og:title" content="peblish federation lab link target">` +
      `<meta property="og:description" content="A page inside the lab for link-post metadata fetches."></head>` +
      `<body><h1>peblish federation lab link target</h1></body></html>`,
  ),
);

// The instance actor (instance.ts) for ActivityPub clients, a page for people.
app.get("/", async (c) => {
  if (!wantsActivityJson(c.req.header("accept"))) {
    return c.html(page("peblish federation lab", "<h1>peblish federation lab</h1><p>Fedify threadiverse lab peer.</p>"));
  }
  const actor = await instanceActor(contextForBackground());
  return c.body(JSON.stringify(await actor.toJsonLd({ format: "compact" })), 200, {
    "content-type": "application/activity+json",
  });
});

app.get("/outbox", (c) =>
  c.body(
    JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: new URL("/outbox", ORIGIN).href,
      type: "OrderedCollection",
      totalItems: 0,
      orderedItems: [],
    }),
    200,
    { "content-type": "application/activity+json" },
  ));
