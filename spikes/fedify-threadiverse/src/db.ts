import postgres from "postgres";
import { DATABASE_URL } from "./config.ts";

// One Postgres database holds both the app tables below and Fedify's KV store
// and message queue (@fedify/postgres creates its own tables).
export const sql = postgres(DATABASE_URL, { max: 10, onnotice: () => {} });

export type ActorKind = "Person" | "Group";
export type ObjectKind = "Page" | "Note";
export type VoteKind = "Like" | "Dislike";

export interface ActorRow {
  identifier: string;
  kind: ActorKind;
  name: string;
  display_name: string;
  summary_md: string;
  created_at: Date;
}

export interface ObjectRow {
  id: string;
  uri: string;
  kind: ObjectKind;
  local: boolean;
  author_uri: string;
  community_uri: string | null;
  in_reply_to: string | null;
  root_uri: string | null;
  title: string | null;
  content_html: string;
  source_md: string | null;
  link_url: string | null;
  published: Date;
  updated: Date | null;
  deleted: boolean;
  removed: boolean;
  locked: boolean;
  stickied: boolean;
  via: string;
}

export interface VoteRow {
  voter_uri: string;
  object_uri: string;
  kind: VoteKind;
  activity_id: string;
  activity: unknown;
}

export async function migrate(): Promise<void> {
  await sql`
    create table if not exists actors (
      identifier text primary key,
      kind text not null check (kind in ('Person', 'Group')),
      name text not null,
      display_name text not null,
      summary_md text not null default '',
      created_at timestamptz not null default now(),
      unique (kind, name)
    )`;
  await sql`
    create table if not exists keys (
      identifier text not null,
      type text not null,
      private_jwk jsonb not null,
      public_jwk jsonb not null,
      primary key (identifier, type)
    )`;
  await sql`
    create table if not exists followers (
      local_identifier text not null,
      actor_uri text not null,
      inbox text not null,
      shared_inbox text,
      follow_id text not null,
      created_at timestamptz not null default now(),
      primary key (local_identifier, actor_uri)
    )`;
  await sql`
    create table if not exists following (
      local_identifier text not null,
      remote_uri text not null,
      follow_id text not null,
      accepted boolean not null default false,
      created_at timestamptz not null default now(),
      primary key (local_identifier, remote_uri)
    )`;
  await sql`
    create table if not exists objects (
      id bigserial primary key,
      uri text not null unique,
      kind text not null check (kind in ('Page', 'Note')),
      local boolean not null,
      author_uri text not null,
      community_uri text,
      in_reply_to text,
      root_uri text,
      title text,
      content_html text not null default '',
      source_md text,
      link_url text,
      published timestamptz not null default now(),
      updated timestamptz,
      deleted boolean not null default false,
      via text not null,
      raw jsonb
    )`;
  await sql`
    create table if not exists votes (
      voter_uri text not null,
      object_uri text not null,
      kind text not null check (kind in ('Like', 'Dislike')),
      activity_id text not null,
      activity jsonb,
      created_at timestamptz not null default now(),
      primary key (voter_uri, object_uri)
    )`;
  // Moderation state (slice 2 probes) and the activities to embed in Undo.
  await sql`alter table objects add column if not exists removed boolean not null default false`;
  await sql`alter table objects add column if not exists locked boolean not null default false`;
  await sql`alter table objects add column if not exists stickied boolean not null default false`;
  await sql`
    create table if not exists mod_actions (
      key text primary key,
      activity jsonb not null,
      created_at timestamptz not null default now()
    )`;
  // Slice 2. Moderators of local communities, by actor URI: remote users may
  // moderate a Feddit community. (Replaces slice 1's `moderators` table.)
  await sql`
    create table if not exists community_moderators (
      community_identifier text not null,
      actor_uri text not null,
      added_at timestamptz not null default now(),
      primary key (community_identifier, actor_uri)
    )`;
  // Moderator lists of remote communities, fetched from the community's origin.
  await sql`
    create table if not exists remote_moderators (
      community_uri text primary key,
      collection_uri text not null,
      moderators text[] not null,
      fetched_at timestamptz not null default now()
    )`;
  await sql`
    create table if not exists bans (
      community_uri text not null,
      actor_uri text not null,
      by_actor text not null,
      reason text,
      expires timestamptz,
      remove_data boolean not null default false,
      activity_id text,
      created_at timestamptz not null default now(),
      primary key (community_uri, actor_uri)
    )`;
  await sql`
    create table if not exists reports (
      id bigserial primary key,
      activity_id text not null unique,
      reporter_uri text not null,
      object_uri text not null,
      community_uri text,
      reason text,
      created_at timestamptz not null default now()
    )`;
  // Ids of inbound activities already applied (direct and announced copies,
  // Lemmy's echoes), so each is applied once.
  await sql`
    create table if not exists processed_activities (
      id text primary key,
      type text not null,
      via text not null,
      at timestamptz not null default now()
    )`;
  await sql`alter table objects add column if not exists removed_reason text`;
  // What the inbox listeners did with each activity; scenarios assert on this.
  await sql`
    create table if not exists inbox_log (
      id bigserial primary key,
      activity_id text,
      type text not null,
      actor text,
      object text,
      via text not null,
      outcome text not null,
      at timestamptz not null default now()
    )`;
}

export async function getActor(identifier: string): Promise<ActorRow | undefined> {
  const [row] = await sql<ActorRow[]>`select * from actors where identifier = ${identifier}`;
  return row;
}

export async function findActorsByName(name: string): Promise<ActorRow[]> {
  return await sql<ActorRow[]>`select * from actors where name = ${name} order by kind desc`;
}

export async function createActor(
  kind: ActorKind,
  name: string,
  displayName: string,
  summaryMd: string,
): Promise<ActorRow> {
  const identifier = `${kind === "Group" ? "c" : "u"}.${name}`;
  const [row] = await sql<ActorRow[]>`
    insert into actors (identifier, kind, name, display_name, summary_md)
    values (${identifier}, ${kind}, ${name}, ${displayName}, ${summaryMd})
    on conflict (identifier) do update set display_name = excluded.display_name
    returning *`;
  return row!;
}

export async function countActors(kind: ActorKind): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from actors where kind = ${kind}`;
  return row?.n ?? 0;
}

export async function getObject(uri: string): Promise<ObjectRow | undefined> {
  const [row] = await sql<ObjectRow[]>`select * from objects where uri = ${uri}`;
  return row;
}

export async function getObjectById(id: string): Promise<ObjectRow | undefined> {
  const [row] = await sql<ObjectRow[]>`select * from objects where id = ${id}`;
  return row;
}

export async function nextObjectId(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select nextval(pg_get_serial_sequence('objects', 'id'))::text as id`;
  return row!.id;
}

export type NewObject = Omit<ObjectRow, "id" | "deleted" | "updated" | "published" | "removed" | "locked" | "stickied"> & {
  id?: string;
  published?: Date;
  raw?: unknown;
};

/** Inserts an object once; a second copy (direct plus Announce) is a no-op. */
export async function insertObject(object: NewObject): Promise<{ inserted: boolean; row: ObjectRow }> {
  const { raw, ...rest } = object;
  const values = { ...rest, raw: raw == null ? null : sql.json(raw as postgres.JSONValue) };
  const inserted = await sql<ObjectRow[]>`
    insert into objects ${sql(values)}
    on conflict (uri) do nothing
    returning *`;
  if (inserted[0]) return { inserted: true, row: inserted[0] };
  return { inserted: false, row: (await getObject(object.uri))! };
}

export async function updateObject(
  uri: string,
  fields: { title?: string | null; content_html: string; source_md: string | null; link_url?: string | null; raw?: unknown },
): Promise<ObjectRow | undefined> {
  const [row] = await sql<ObjectRow[]>`
    update objects set
      title = coalesce(${fields.title ?? null}, title),
      content_html = ${fields.content_html},
      source_md = ${fields.source_md},
      link_url = coalesce(${fields.link_url ?? null}, link_url),
      updated = now(),
      raw = coalesce(${fields.raw == null ? null : sql.json(fields.raw as postgres.JSONValue)}, raw)
    where uri = ${uri}
    returning *`;
  return row;
}

export async function markDeleted(uri: string): Promise<ObjectRow | undefined> {
  const [row] = await sql<ObjectRow[]>`
    update objects set deleted = true, updated = now() where uri = ${uri} returning *`;
  return row;
}

export async function listCommunityPosts(communityUri: string, limit = 20): Promise<ObjectRow[]> {
  return await sql<ObjectRow[]>`
    select * from objects
    where community_uri = ${communityUri} and kind = 'Page' and not deleted
    order by published desc limit ${limit}`;
}

export async function countLocalObjects(kind: ObjectKind): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from objects where local and kind = ${kind}`;
  return row?.n ?? 0;
}

export async function upsertVote(vote: VoteRow): Promise<void> {
  const activity = vote.activity == null ? null : sql.json(vote.activity as postgres.JSONValue);
  await sql`
    insert into votes (voter_uri, object_uri, kind, activity_id, activity)
    values (${vote.voter_uri}, ${vote.object_uri}, ${vote.kind}, ${vote.activity_id}, ${activity})
    on conflict (voter_uri, object_uri) do update
      set kind = excluded.kind, activity_id = excluded.activity_id, activity = excluded.activity`;
}

export async function getVote(voterUri: string, objectUri: string): Promise<VoteRow | undefined> {
  const [row] = await sql<VoteRow[]>`
    select voter_uri, object_uri, kind, activity_id, activity from votes
    where voter_uri = ${voterUri} and object_uri = ${objectUri}`;
  return row;
}

export async function deleteVote(voterUri: string, objectUri: string): Promise<boolean> {
  const rows = await sql`delete from votes where voter_uri = ${voterUri} and object_uri = ${objectUri} returning 1`;
  return rows.length > 0;
}

export async function setObjectFlag(
  uri: string,
  column: "removed" | "locked" | "stickied" | "deleted",
  value: boolean,
  reason?: string | null,
): Promise<ObjectRow | undefined> {
  const [row] = await sql<ObjectRow[]>`
    update objects set ${sql(column)} = ${value}, updated = now()
      ${column === "removed" ? sql`, removed_reason = ${value ? (reason ?? null) : null}` : sql``}
    where uri = ${uri} returning *`;
  return row;
}

/** True the first time an inbound activity id is seen. */
export async function markProcessed(id: string, type: string, via: string): Promise<boolean> {
  const rows = await sql`
    insert into processed_activities (id, type, via) values (${id}, ${type}, ${via})
    on conflict (id) do nothing returning 1`;
  return rows.length > 0;
}

export async function logInbox(entry: {
  activityId: string | null;
  type: string;
  actor: string | null;
  object: string | null;
  via: "direct" | "announce";
  outcome: string;
}): Promise<void> {
  await sql`
    insert into inbox_log (activity_id, type, actor, object, via, outcome)
    values (${entry.activityId}, ${entry.type}, ${entry.actor}, ${entry.object}, ${entry.via}, ${entry.outcome})`;
}
