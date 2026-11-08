import {
  type Context,
  createFederation,
  exportJwk,
  generateCryptoKeyPair,
  importJwk,
  type NodeInfo,
} from "@fedify/fedify";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import { Endpoints, Group, Note, Page, Person, Source } from "@fedify/vocab";
import { ALLOW_PRIVATE_ADDRESS, NODE_NAME, ORIGIN, SOFTWARE } from "./config.ts";
import { createFor, markdownToHtml, toInstant, toVocab } from "./content.ts";
import * as db from "./db.ts";
import { sql } from "./db.ts";

// Fedify serves actors, objects, collections, WebFinger and NodeInfo, verifies
// inbound signatures and queues inbound processing (inbox.ts). Outbound
// delivery does not use Fedify: see outbox.ts for why.
export const federation = createFederation<void>({
  kv: new PostgresKvStore(sql),
  queue: new PostgresMessageQueue(sql),
  origin: ORIGIN.href,
  manuallyStartQueue: true,
  allowPrivateAddress: ALLOW_PRIVATE_ADDRESS,
  userAgent: { software: `${SOFTWARE.name}/${SOFTWARE.version}`, url: ORIGIN },
});

// ------------------------------------------------------------------ actors

/**
 * One actor URL template serves both kinds (Fedify allows one per Federation,
 * issue 646). Identifiers carry the kind: `u.alice` (Person) and `c.spike`
 * (Group), so users and communities may share a name; `url` points at the
 * human pages /u/alice and /c/spike.
 */
federation
  .setActorDispatcher("/ap/{identifier}", async (ctx, identifier) => {
    const actor = await db.getActor(identifier);
    if (!actor) return null;
    const keys = await ctx.getActorKeyPairs(identifier);
    const values = {
      id: ctx.getActorUri(identifier),
      preferredUsername: actor.name,
      name: actor.display_name,
      summary: actor.summary_md ? markdownToHtml(actor.summary_md) : null,
      source: actor.summary_md
        ? new Source({ content: actor.summary_md, mediaType: "text/markdown" })
        : null,
      url: new URL(`/${actor.kind === "Group" ? "c" : "u"}/${actor.name}`, ORIGIN),
      inbox: ctx.getInboxUri(identifier),
      outbox: ctx.getOutboxUri(identifier),
      followers: ctx.getFollowersUri(identifier),
      endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
      publicKey: keys[0]?.cryptographicKey,
      assertionMethods: keys.map((pair) => pair.multikey),
      published: toInstant(actor.created_at),
      manuallyApprovesFollowers: false,
      // Every actor has one: the featured dispatcher serves both kinds (an
      // empty collection for a Person), and Fedify warns when it is missing.
      featured: ctx.getFeaturedUri(identifier),
    };
    if (actor.kind === "Person") return new Person(values);
    // Lemmy's community parser needs `attributedTo` (moderators) and `featured`.
    return new Group({
      ...values,
      attribution: ctx.getCollectionUri("moderators", { identifier }),
    });
  })
  .setKeyPairsDispatcher(async (_ctx, identifier) => {
    if (!(await db.getActor(identifier))) return [];
    const pairs: CryptoKeyPair[] = [];
    // RSA for draft-cavage signatures (what Lemmy and PieFed read from
    // `publicKey`), Ed25519 for Object Integrity Proofs.
    for (const type of ["RSASSA-PKCS1-v1_5", "Ed25519"] as const) {
      pairs.push(await loadOrCreateKeyPair(identifier, type));
    }
    return pairs;
  })
  .mapHandle(async (_ctx, username) => {
    // Person first when a user and a community share a name; the Group is
    // then added as a second `self` link (Lemmy tries every link).
    const [first] = await db.findActorsByName(username);
    return first?.identifier ?? null;
  });

export async function loadOrCreateKeyPair(
  identifier: string,
  type: "RSASSA-PKCS1-v1_5" | "Ed25519",
): Promise<CryptoKeyPair> {
  const read = async () => {
    const [row] = await sql<{ private_jwk: JsonWebKey; public_jwk: JsonWebKey }[]>`
      select private_jwk, public_jwk from keys where identifier = ${identifier} and type = ${type}`;
    return row;
  };
  const existing = await read();
  if (existing) {
    return {
      privateKey: await importJwk(existing.private_jwk, "private"),
      publicKey: await importJwk(existing.public_jwk, "public"),
    };
  }
  const pair = await generateCryptoKeyPair(type);
  const inserted = await sql`
    insert into keys (identifier, type, private_jwk, public_jwk)
    values (${identifier}, ${type}, ${sql.json((await exportJwk(pair.privateKey)) as never)},
            ${sql.json((await exportJwk(pair.publicKey)) as never)})
    on conflict do nothing returning 1`;
  // A concurrent request may have won the race; use the stored pair then.
  return inserted.length > 0 ? pair : await loadOrCreateKeyPair(identifier, type);
}

federation.setWebFingerLinksDispatcher(async (ctx, resource) => {
  const match = /^acct:([^@]+)@/.exec(resource.href);
  if (!match?.[1]) return [];
  const actors = await db.findActorsByName(decodeURIComponent(match[1]));
  return actors.slice(1).map((actor) => ({
    rel: "self",
    type: "application/activity+json",
    href: ctx.getActorUri(actor.identifier).href,
    properties: { "https://www.w3.org/ns/activitystreams#type": actor.kind },
  }));
});

// ------------------------------------------------------------------ objects

federation.setObjectDispatcher(Page, "/ap/post/{id}", async (_ctx, { id }) => {
  const row = await db.getObjectById(id);
  if (!row?.local || row.kind !== "Page") return null;
  const object = toVocab(row);
  return object instanceof Note ? null : object;
});

federation.setObjectDispatcher(Note, "/ap/comment/{id}", async (_ctx, { id }) => {
  const row = await db.getObjectById(id);
  if (!row?.local || row.kind !== "Note") return null;
  const object = toVocab(row);
  return object instanceof Page ? null : object;
});

// ------------------------------------------------------------------ collections

federation
  .setFollowersDispatcher("/ap/{identifier}/followers", async (_ctx, identifier) => {
    const rows = await sql<{ actor_uri: string; inbox: string; shared_inbox: string | null }[]>`
      select actor_uri, inbox, shared_inbox from followers where local_identifier = ${identifier}`;
    return {
      items: rows.map((row) => ({
        id: new URL(row.actor_uri),
        inboxId: new URL(row.inbox),
        endpoints: row.shared_inbox ? { sharedInbox: new URL(row.shared_inbox) } : null,
      })),
    };
  })
  // Lemmy reads only `totalItems` from a community's followers collection.
  .setCounter(async (_ctx, identifier) => {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from followers where local_identifier = ${identifier}`;
    return row?.n ?? 0;
  });

federation
  .setOutboxDispatcher("/ap/{identifier}/outbox", async (ctx, identifier) => {
    const actor = await db.getActor(identifier);
    if (!actor) return null;
    if (actor.kind !== "Group") return { items: [] };
    const community = ctx.getActorUri(identifier);
    const posts = await db.listCommunityPosts(community.href);
    // Only locally authored posts: the Create's id shares the author's origin.
    const items = posts
      .filter((post) => post.local)
      .map((post) => {
        const page = toVocab(post);
        return page instanceof Page
          ? createFor(new URL(post.author_uri), page, community, stableCreateId(post.id))
          : null;
      })
      .filter((item) => item != null);
    return { items };
  })
  .setCounter(async (ctx, identifier) => {
    const posts = await db.listCommunityPosts(ctx.getActorUri(identifier).href, 1000);
    return posts.filter((post) => post.local).length;
  });

export function stableCreateId(objectId: string): URL {
  return new URL(`/ap/activities/create/object-${objectId}`, ORIGIN);
}

// Stickied posts, the target of moderator Add/Remove. Lemmy reads full Pages.
async function stickiedPosts(ctx: Context<void>, identifier: string) {
  const posts = await db.listCommunityPosts(ctx.getActorUri(identifier).href, 1000);
  return posts.filter((post) => post.stickied);
}

federation
  .setFeaturedDispatcher("/ap/{identifier}/featured", async (ctx, identifier) => ({
    items: (await stickiedPosts(ctx, identifier)).map(toVocab),
  }))
  .setCounter(async (ctx, identifier) => (await stickiedPosts(ctx, identifier)).length);

federation.setOrderedCollectionDispatcher(
  "moderators",
  Person,
  "/ap/{identifier}/moderators",
  async (ctx, { identifier }) => {
    const actor = await db.getActor(identifier);
    if (actor?.kind !== "Group") return null;
    const rows = await sql<{ actor_uri: string }[]>`
      select actor_uri from community_moderators where community_identifier = ${identifier}
      order by added_at`;
    // Flattened to IRIs in routes.ts; remote moderators are listed the same way.
    return { items: rows.map((row) => new Person({ id: new URL(row.actor_uri) })) };
  },
);

// ------------------------------------------------------------------ NodeInfo

federation.setNodeInfoDispatcher("/nodeinfo/2.1", async () => await buildNodeInfo());

/** NodeInfo 2.1; PieFed marks peers dormant when `usage.users` is missing. */
export async function buildNodeInfo(): Promise<NodeInfo> {
  const users = await db.countActors("Person");
  return {
    software: {
      name: SOFTWARE.name,
      version: SOFTWARE.version,
      homepage: new URL("/", ORIGIN),
    },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: {
      users: { total: users, activeMonth: users, activeHalfyear: users },
      localPosts: await db.countLocalObjects("Page"),
      localComments: await db.countLocalObjects("Note"),
    },
    // Same name as the instance actor at / (instance.ts).
    metadata: { nodeName: NODE_NAME },
  };
}

// ------------------------------------------------------------------ helpers

export function contextForBackground(): Context<void> {
  return federation.createContext(ORIGIN, undefined);
}

/** The local Group identifier a URI points at, if any. */
export function localGroup(ctx: Context<void>, uri: URL | null | undefined): string | null {
  if (!uri) return null;
  const parsed = ctx.parseUri(uri);
  return parsed?.type === "actor" && parsed.identifier.startsWith("c.") ? parsed.identifier : null;
}

export function isLocalActor(ctx: Context<void>, uri: URL | null | undefined): boolean {
  return uri != null && ctx.parseUri(uri)?.type === "actor";
}

