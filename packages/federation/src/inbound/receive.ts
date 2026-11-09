import { createHash } from 'node:crypto';
import { db, type Queryable } from '@peblish/core/db/read';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { inboxRaw } from '@peblish/core/db/tables/federation';
import { intakeFor } from '@peblish/core/peers/gate';
import { readSetting } from '@peblish/core/settings/read';
import { tx } from '@peblish/core/tx/tx';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Fetcher } from '../actors/document.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import { FetchRefused, verifyInboundSignature } from '../signing/inbound.ts';
import { parseSignature } from '../signing/verify.ts';
import { clientAddress, peerOf } from './client.ts';
import { takeIntake, takeKeyLookup } from './throttle.ts';

// The inbox's front door (lane FED-A's http.ts routes every inbox POST here). It does the
// least that is safe and answers fast; applying the activity is the pipeline's, a moment later
// in the worker (pipeline.ts):
//
//   inbox.enabled off  503 + Retry-After   the one maintenance answer an inbox may give
//   body over 512 KiB  413                 by Content-Length, or counted as a chunked body streams in
//   bad signature      401                 draft-cavage, the key's owner is the activity's actor
//   an account's own   202                 a Delete of an account we do not hold, signed with a key that can no
//   Delete, no key                         longer be fetched (Mastodon sends it after the account is gone):
//                                          nothing to apply, answered so the peer stops retrying
//   blocked peer       403                 the signer's instance is blocked here (peers/gate.ts); nothing is stored
//   paused peer        503 + Retry-After   the signer's instance has its inbox paused; it retries, nothing is lost
//   not an activity    400                 or a body that is not strictly UTF-8: the relay sends the exact bytes, which
//                                          must then be exactly the text that was read
//   throttled          429 + Retry-After   too many key lookups from this address or for this host (throttle.ts), or
//                                          the signer or its instance is over its request rate or has too many
//                                          bytes waiting in inbox_raw
//   a repeat           202                 the same body, or an activity id seen within the hour, is not stored again
//                                          and costs none of the signer's allowance (it is recognised first)
//   stored             202                 the exact bytes, in inbox_raw; the repeat check, the pending count and the
//                                          insert are one step per instance, so concurrent requests are counted in turn
//
// Never 410 (peers read it as "this actor is gone"), 418 or an unexpected 5xx: a failure we did
// not expect, a storage error included, is the 503 peers retry.

export const maxBodyBytes = 512 * 1024;
const retryAfter = { 'Retry-After': '300' };
/** Bytes a signer, and all the signers of one instance, may have waiting in inbox_raw (a pipeline that falls behind makes peers wait). */
export const pendingBytesLimit = { signer: 8 * 1024 * 1024, instance: 32 * 1024 * 1024 };
/** How long a body or an activity id counts as already received. */
const repeatWindowMs = 60 * 60_000;
/** The request headers a signature covers, kept with the body so it can be checked again. */
const keptHeaders = ['host', 'date', 'digest', 'signature', 'content-type', 'content-length', 'user-agent'];

/** Strict: a body that is not valid UTF-8 (or starts with a byte order mark) does not survive a decode and encode, so it is not taken. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const refuse = (status: number, text: string, headers?: Record<string, string>) => new Response(text, { status, headers });

/** The body, or null once it is over the limit (counted as it streams, so a chunked body cannot slip past). */
async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBodyBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Bodies received lately, by signer and digest, so a repeat is answered without a query. Bounded:
// the oldest is forgotten past the cap (the activity id check in the database still catches it).
// Per process; on globalThis because the web build can hold two copies of a module.
const receipts = ((globalThis as { __peblishInboxReceipts?: Map<string, number> }).__peblishInboxReceipts ??= new Map());
const receiptsMax = 5000;

const receiptKey = (signer: string, body: Uint8Array) => `${signer}\n${createHash('sha256').update(body).digest('base64')}`;

function rememberReceipt(key: string, now: number): void {
  receipts.delete(key);
  receipts.set(key, now);
  if (receipts.size > receiptsMax) receipts.delete(receipts.keys().next().value!);
}

/** Whether this signer sent this body, or this activity id, within the window. */
async function isRepeat(q: Queryable, key: string, signer: string, activityId: string | null, now: number): Promise<boolean> {
  const seen = receipts.get(key);
  if (seen !== undefined && now - seen < repeatWindowMs) return true;
  if (activityId === null) return false;
  const [row] = await q
    .select({ id: inboxRaw.id })
    .from(inboxRaw)
    .where(
      and(eq(inboxRaw.activityId, activityId), eq(inboxRaw.actorApId, signer), gt(inboxRaw.receivedAt, new Date(now - repeatWindowMs))),
    )
    .limit(1);
  return row !== undefined;
}

/** Whether taking `incoming` more bytes would leave the signer, or its instance, with more waiting in inbox_raw than the limit allows. */
async function overPendingLimit(q: Queryable, signer: string, incoming: number): Promise<boolean> {
  const [row] = await q.execute<{ signer: string; instance: string }>(sql`
    select
      coalesce(sum(octet_length(body)) filter (where actor_ap_id = ${signer}), 0)::text as signer,
      coalesce(sum(octet_length(body)), 0)::text as instance
    from inbox_raw
    where state = 'pending' and starts_with(actor_ap_id, ${`${new URL(signer).origin}/`})`);
  return Number(row?.signer) + incoming > pendingBytesLimit.signer || Number(row?.instance) + incoming > pendingBytesLimit.instance;
}

/**
 * Takes the request into inbox_raw unless it is a repeat or would put the signer, or its
 * instance, over the pending limit. The repeat check, the pending count and the insert are one
 * step per instance (an advisory lock on the instance, held to the commit), so concurrent
 * requests, identical or large, are counted one after another and cannot all pass on the same
 * count. A repeat is remembered before the commit and forgotten if it fails.
 */
/** The advisory lock key admission takes for the instance at `origin` (exported for the tests that hold it). */
export const admissionLock = (origin: string): string => `inbox:${origin}`;

async function admit(
  row: typeof inboxRaw.$inferInsert & { actorApId: string },
  receipt: string,
  now: number,
): Promise<'stored' | 'repeat' | 'full'> {
  try {
    return await tx(async (t) => {
      await t.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${admissionLock(new URL(row.actorApId).origin)}, 0))`);
      if (await isRepeat(t.db, receipt, row.actorApId, row.activityId ?? null, now)) return 'repeat';
      if (await overPendingLimit(t.db, row.actorApId, row.body.byteLength)) return 'full';
      await t.db.insert(inboxRaw).values(row);
      rememberReceipt(receipt, now);
      return 'stored';
    });
  } catch (error) {
    receipts.delete(receipt);
    throw error;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null =>
  typeof value === 'string' ? value : isObject(value) && typeof value.id === 'string' ? value.id : null;

export type ReceiveOptions = {
  /** For tests: the fetcher an unknown signing key's actor is read with. */
  fetch?: Fetcher;
  /** The address of the connection's peer, when the caller knows it better than the request does (`request.ip`). */
  peer?: string;
};

/** Most fetches the lookup of one request's signing key may make: the key document, the actor, its NodeInfo, a hop or two. */
const maxLookupFetches = 8;

/**
 * Whether the key id of the request's signature names an actor, or a key, we hold: its lookup is
 * a refresh of what we know, not a discovery of a stranger, and has its own budget.
 */
async function namesHeldSigner(request: Request, body: Uint8Array): Promise<boolean> {
  const parsed = parseSignature(request, body);
  if (typeof parsed === 'string' || !URL.canParse(parsed.keyId)) return false;
  const actor = new URL(parsed.keyId);
  actor.hash = '';
  const [row] = await db().execute<{ held: boolean }>(sql`
    select (
      exists (select 1 from ${actors} where ${actors.apId} = ${actor.href})
      or exists (select 1 from ${actorKeys} where ${actorKeys.keyId} = ${parsed.keyId})
    ) as held`);
  return row?.held === true;
}

/**
 * Whether `body` is an account's Delete of itself for an account we do not hold (or hold as
 * deleted): there is nothing in it to apply, and no one to ask for the key of an actor that is
 * gone. Nothing is stored: the body is not authenticated.
 */
async function isGoneAccountsDelete(body: Uint8Array): Promise<boolean> {
  let json: unknown;
  try {
    json = JSON.parse(utf8.decode(body));
  } catch {
    return false;
  }
  if (!isObject(json) || json.type !== 'Delete') return false;
  const actor = idOf(json.actor);
  if (actor === null || idOf(json.object) !== actor) return false;
  const [held] = await db().select({ deletedAt: actors.deletedAt }).from(actors).where(eq(actors.apId, actor));
  return !held || held.deletedAt !== null;
}

/** Answers one inbox POST. */
export async function receiveInbound(request: Request, options: ReceiveOptions = {}): Promise<Response> {
  try {
    if (!(await readSetting('inbox.enabled'))) return refuse(503, 'the inbox is paused', retryAfter);
    const body = await readBody(request);
    if (body === null) return refuse(413, 'the body is larger than 512 KiB');

    let throttled = false;
    let fetches = 0;
    const base = options.fetch ?? safeFetch;
    const address = clientAddress(request.headers, options.peer ?? peerOf(request));
    // Finding a signer's key is a few fetches (the key document, the actor, its NodeInfo), but one
    // lookup: it is charged once, at the first, to the client and to the host the key id names.
    const limited: Fetcher = async (url, init) => {
      if (fetches === 0) {
        const kind = (await namesHeldSigner(request, body)) ? 'refresh' : 'discovery';
        if (!takeKeyLookup(kind, { address, host: new URL(String(url)).host })) {
          throttled = true;
          throw new FetchRefused('too many lookups of signing keys');
        }
      }
      if (++fetches > maxLookupFetches) throw new FetchRefused('this lookup needs more fetches than it may make');
      return base(url, init);
    };
    const signature = await verifyInboundSignature(request, body, { fetch: limited });
    if (!signature.ok) {
      if (throttled) return refuse(429, 'slow down', retryAfter);
      if (signature.reason === 'key_unknown' && (await isGoneAccountsDelete(body))) return refuse(202, 'skipped: actor.unresolvable');
      return refuse(401, `signature: ${signature.reason}`);
    }

    let activity: unknown;
    try {
      activity = JSON.parse(utf8.decode(body));
    } catch {
      return refuse(400, 'the body is not UTF-8 JSON');
    }
    const actor = isObject(activity) ? idOf(activity.actor) : null;
    if (!isObject(activity) || typeof activity.type !== 'string' || actor === null) return refuse(400, 'not an activity');
    // The key must be the actor's own: a server speaks for its own people, and nobody else's.
    if (signature.ownerApId !== actor) return refuse(401, 'signature: the key does not belong to the actor');
    // What the admin decided about this peer (M18): a paused inbox asks it to come back, a blocked one is refused. Nothing is stored either way.
    const intake = await intakeFor(db(), signature.ownerApId);
    if (intake === 'blocked') return refuse(403, 'this instance is blocked here');
    if (intake === 'paused') return refuse(503, 'the inbox is paused for your instance', retryAfter);
    // From here the sender is authenticated, so its allowance is spent by its own key only. A
    // repeat is recognised first and costs none of it: a peer retrying what it got no answer to
    // must not be told to slow down for it.
    const now = Date.now();
    const activityId = typeof activity.id === 'string' ? activity.id : null;
    const receipt = receiptKey(actor, body);
    if (await isRepeat(db(), receipt, actor, activityId, now)) return new Response(null, { status: 202 });
    if (!takeIntake(actor, now)) return refuse(429, 'slow down', retryAfter);

    const { pathname, search } = new URL(request.url);
    const headers = { method: request.method, path: `${pathname}${search}`, signer: signature.ownerApId, keyId: signature.keyId } as Record<
      string,
      string
    >;
    for (const name of keptHeaders) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const outcome = await admit({ activityId, activityType: activity.type as string, actorApId: actor, body, headers }, receipt, now);
    if (outcome === 'full') return refuse(429, 'too much of yours is waiting to be processed', retryAfter);
    return new Response(null, { status: 202 });
  } catch (error) {
    console.error('inbound: could not take the activity', error);
    return refuse(503, 'try again later', retryAfter);
  }
}
