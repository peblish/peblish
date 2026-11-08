// Durable, at-least-once delivery for every activity Feddit sends.
//
// Fedify's own sendActivity path was dropped for three reasons found in the
// lab: it re-serialises third-party activities lossily (relays), it retries
// a refused delivery with a second signature scheme Lemmy 0.19 cannot verify
// (double knock on any 4xx), and @fedify/postgres deletes a queue message
// before its handler runs, so a crash mid-delivery loses it. Here each
// (activity, inbox) pair is a row; a worker claims rows under a lease, signs
// once with draft-cavage-12, POSTs through safe-post.ts (inbox URLs come from
// remote actor documents) and records the outcome. A worker that dies
// mid-POST leaves the lease to expire and the row is sent again; receivers
// de-duplicate on the activity id.
import { type Context, signRequest } from "@fedify/fedify";
import type { Activity } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { capture, parseMaybeJson, pickHeaders } from "./capture.ts";
import { OUTBOX } from "./config.ts";
import { sql } from "./db.ts";
import { BlockedDestinationError, safePost } from "./safe-post.ts";

const logger = getLogger(["feddit", "outbox"]);

/** Statuses after which a retry cannot help. 401, 408, 429 and 5xx are retried. */
const PERMANENT = new Set([400, 403, 404, 405, 410, 413, 422]);

export interface OutboxRow {
  id: string;
  activity_id: string;
  sender: string;
  inbox: string;
  body: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_status: number | null;
  last_error: string | null;
}

export async function migrateOutbox(): Promise<void> {
  await sql`
    create table if not exists outbox (
      id bigserial primary key,
      activity_id text not null,
      activity_type text not null,
      -- what the activity is about (an Announce's inner activity), for lookups
      object_id text,
      sender text not null,
      inbox text not null,
      body text not null,
      status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
      attempts int not null default 0,
      next_attempt_at timestamptz not null default now(),
      lease_until timestamptz,
      last_status int,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (activity_id, inbox)
    )`;
  await sql`alter table outbox add column if not exists object_id text`;
  await sql`create index if not exists outbox_due on outbox (next_attempt_at) where status = 'pending'`;
}

/** Every delivery of the activities about `objectId` (for the delivery scenarios). */
export async function outboxRows(objectId: string) {
  return await sql`
    select id, activity_id, activity_type, object_id, inbox, status, attempts, last_status, last_error
    from outbox where object_id = ${objectId} or activity_id = ${objectId} order by id`;
}

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const ADDRESSING = new Set(["to", "cc", "bto", "bcc", "audience"]);

/**
 * Undoes two effects of JSON-LD compaction on JSON Fedify serialised from our
 * own activities, as Fedify's sendActivity does internally
 * (normalizeOutgoingActivityJsonLd, not exported):
 * - the Public collection comes out as the CURIE `as:Public`; Lemmy compares
 *   addressing as plain URLs and answers `object_is_not_public`;
 * - a one-element `attachment` comes out as a bare object; Lemmy's Page wants
 *   an array ("did not match any variant of untagged enum").
 * Our contexts all come from Fedify's preloaded set, so both keep meaning.
 */
function normalizeOutgoing(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key && ADDRESSING.has(key) && (value === "as:Public" || value === "Public") ? PUBLIC : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeOutgoing(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => {
        if (name === "@context") return [name, item];
        const normalized = normalizeOutgoing(item, name);
        return [name, name === "attachment" && !Array.isArray(normalized) ? [normalized] : normalized];
      }),
    );
  }
  return value;
}

/**
 * Queues `activity` (a Fedify object, or plain JSON for types Fedify lacks)
 * for each inbox, signed later by the local actor `sender`. The JSON is fixed
 * now, so every retry sends the same bytes.
 */
export async function enqueue(
  sender: string,
  activity: Activity | Record<string, unknown>,
  inboxes: Iterable<string | URL>,
): Promise<number> {
  const json = "toJsonLd" in activity && typeof activity.toJsonLd === "function"
    ? normalizeOutgoing(await (activity as Activity).toJsonLd({ format: "compact" })) as Record<string, unknown>
    : activity as Record<string, unknown>;
  const id = String(json.id ?? "");
  if (!id) throw new Error("activity without id");
  const targets = [...new Set([...inboxes].map((inbox) => new URL(inbox).href))];
  if (targets.length === 0) return 0;
  const body = JSON.stringify(json);
  const type = String(json.type ?? "Activity");
  const inner = json.object;
  const objectId = typeof inner === "string" ? inner : inner && typeof inner === "object" && "id" in inner ? String(inner.id) : null;
  const rows = targets.map((inbox) => ({ activity_id: id, activity_type: type, object_id: objectId, sender, inbox, body }));
  await sql`insert into outbox ${sql(rows)} on conflict (activity_id, inbox) do nothing`;
  logger.info("Queued {type} {id} for {count} inboxes", { type, id, count: targets.length });
  wake();
  return targets.length;
}

// ------------------------------------------------------------------ worker

let held = false;
let wakeUp: (() => void) | null = null;

function wake() {
  wakeUp?.();
}

/** Lab control: while held, the worker claims nothing (the rows stay pending). */
export function setHold(value: boolean): void {
  held = value;
  if (!value) wake();
}

export function isHeld(): boolean {
  return held;
}

function backoffMs(attempts: number): number {
  return Math.min(OUTBOX.baseDelayMs * OUTBOX.factor ** (attempts - 1), OUTBOX.maxDelayMs);
}

async function claim(limit: number): Promise<OutboxRow[]> {
  return await sql<OutboxRow[]>`
    update outbox set
      attempts = attempts + 1,
      lease_until = now() + ${`${OUTBOX.leaseMs} milliseconds`}::interval,
      updated_at = now()
    where id in (
      select id from outbox
      where status = 'pending' and next_attempt_at <= now()
        and (lease_until is null or lease_until < now())
      order by id
      limit ${limit}
      for update skip locked
    )
    returning id, activity_id, sender, inbox, body, status, attempts, last_status, last_error`;
}

async function finish(
  row: OutboxRow,
  status: number | null,
  error: string | null,
  refused = false,
): Promise<void> {
  const delivered = status != null && status >= 200 && status < 300;
  // A redirect is never followed, and a blocked destination never unblocks.
  const permanent = refused || (status != null && (PERMANENT.has(status) || (status >= 300 && status < 400)));
  const exhausted = row.attempts >= OUTBOX.maxAttempts;
  const outcome = delivered ? "delivered" : permanent || exhausted ? "failed" : "pending";
  const delay = outcome === "pending" ? backoffMs(row.attempts) : 0;
  await sql`
    update outbox set
      status = ${outcome},
      last_status = ${status},
      last_error = ${error},
      lease_until = null,
      next_attempt_at = now() + ${`${delay} milliseconds`}::interval,
      updated_at = now()
    where id = ${row.id}`;
  const level = outcome === "delivered" ? "debug" : "warn";
  logger[level]("{outcome} {id} to {inbox} (attempt {attempts}, status {status}){error}", {
    outcome,
    id: row.activity_id,
    inbox: row.inbox,
    attempts: row.attempts,
    status,
    error: error ? `: ${error}` : "",
  });
}

async function deliver(ctx: Context<void>, row: OutboxRow): Promise<void> {
  const started = Date.now();
  let headers = new Headers();
  try {
    const keyPair = await signingKey(ctx, row.sender);
    const request = await signRequest(
      new Request(row.inbox, {
        method: "POST",
        headers: { "content-type": "application/activity+json", accept: "application/activity+json" },
        body: row.body,
      }),
      keyPair.privateKey,
      keyPair.keyId,
      { spec: "draft-cavage-http-signatures-12" },
    );
    headers = request.headers;
    const response = await safePost(row.inbox, request.headers, row.body, OUTBOX.requestTimeoutMs);
    capture("outbound", {
      method: "POST",
      url: row.inbox,
      status: response.status,
      ms: Date.now() - started,
      attempt: row.attempts,
      requestHeaders: pickHeaders(request.headers),
      body: parseMaybeJson(row.body),
      response: parseMaybeJson(response.body),
      ...(response.location ? { location: response.location } : {}),
    });
    const ok = response.status >= 200 && response.status < 300;
    const note = response.location ? `redirect to ${response.location} not followed` : response.body.slice(0, 300);
    await finish(row, response.status, ok ? null : note || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    capture("outbound", {
      method: "POST",
      url: row.inbox,
      error: message,
      attempt: row.attempts,
      requestHeaders: pickHeaders(headers),
      body: parseMaybeJson(row.body),
    });
    await finish(row, null, message, error instanceof BlockedDestinationError);
  }
}

/** The RSA key (draft-cavage) of a local actor, or of the instance actor. */
let signingKey: (ctx: Context<void>, sender: string) => Promise<{ privateKey: CryptoKey; keyId: URL }> = async (
  ctx,
  sender,
) => {
  const [pair] = await ctx.getActorKeyPairs(sender);
  if (!pair) throw new Error(`no key pair for ${sender}`);
  return { privateKey: pair.privateKey, keyId: pair.keyId };
};

/** Lets the instance actor (not a Fedify actor) sign its own deliveries. */
export function setSigningKeyResolver(resolver: typeof signingKey): void {
  signingKey = resolver;
}

/** Runs forever: claims due rows, delivers them in parallel, then waits. */
export async function runOutboxWorker(ctx: Context<void>): Promise<never> {
  for (;;) {
    const rows = held ? [] : await claim(16);
    if (rows.length > 0) {
      await Promise.all(rows.map((row) => deliver(ctx, row)));
      continue;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wakeUp = null;
  }
}

/** Row counts and the latest rows, for /spike/state. */
export async function outboxSnapshot(limit = 50) {
  const counts = await sql<{ status: string; n: number }[]>`
    select status, count(*)::int as n from outbox group by status`;
  const recent = await sql`
    select id, activity_id, activity_type, object_id, sender, inbox, status, attempts, last_status, last_error, created_at, updated_at
    from outbox order by id desc limit ${limit}`;
  return { held, counts: Object.fromEntries(counts.map((row) => [row.status, row.n])), recent };
}
