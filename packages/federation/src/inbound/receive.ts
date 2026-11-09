import { createHash } from 'node:crypto';
import { db } from '@peblish/core/db/read';
import { inboxRaw } from '@peblish/core/db/tables/federation';
import { readSetting } from '@peblish/core/settings/read';
import { tx } from '@peblish/core/tx/tx';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Fetcher } from '../actors/document.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import { verifyInboundSignature } from '../signing/inbound.ts';
import { takeIntake, takeKeyFetch } from './throttle.ts';

// The inbox's front door (lane FED-A's http.ts routes every inbox POST here). It does the
// least that is safe and answers fast; applying the activity is the pipeline's, a moment later
// in the worker (pipeline.ts):
//
//   inbox.enabled off  503 + Retry-After   the one maintenance answer an inbox may give
//   body over 512 KiB  413                 by Content-Length, or counted as a chunked body streams in
//   bad signature      401                 draft-cavage, the key's owner is the activity's actor
//   not an activity    400
//   throttled          429 + Retry-After   too many unknown keys at once, or the signer or its instance is over
//                                          its request rate or has too many bytes waiting in inbox_raw
//   a repeat           202                 the same body, or an activity id seen within the hour, is not stored again
//   stored             202                 the exact bytes, in inbox_raw
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
async function isRepeat(key: string, signer: string, activityId: string | null, now: number): Promise<boolean> {
  const seen = receipts.get(key);
  if (seen !== undefined && now - seen < repeatWindowMs) return true;
  if (activityId === null) return false;
  const [row] = await db()
    .select({ id: inboxRaw.id })
    .from(inboxRaw)
    .where(
      and(eq(inboxRaw.activityId, activityId), eq(inboxRaw.actorApId, signer), gt(inboxRaw.receivedAt, new Date(now - repeatWindowMs))),
    )
    .limit(1);
  return row !== undefined;
}

/** Whether the signer, or its instance, already has more waiting in inbox_raw than the limit allows. */
async function overPendingLimit(signer: string): Promise<boolean> {
  const [row] = await db().execute<{ signer: string; instance: string }>(sql`
    select
      coalesce(sum(octet_length(body)) filter (where actor_ap_id = ${signer}), 0)::text as signer,
      coalesce(sum(octet_length(body)), 0)::text as instance
    from inbox_raw
    where state = 'pending' and starts_with(actor_ap_id, ${`${new URL(signer).origin}/`})`);
  return Number(row?.signer) > pendingBytesLimit.signer || Number(row?.instance) > pendingBytesLimit.instance;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null =>
  typeof value === 'string' ? value : isObject(value) && typeof value.id === 'string' ? value.id : null;

export type ReceiveOptions = {
  /** For tests: the fetcher an unknown signing key's actor is read with. */
  fetch?: Fetcher;
};

/** Answers one inbox POST. */
export async function receiveInbound(request: Request, options: ReceiveOptions = {}): Promise<Response> {
  try {
    if (!(await readSetting('inbox.enabled'))) return refuse(503, 'the inbox is paused', retryAfter);
    const body = await readBody(request);
    if (body === null) return refuse(413, 'the body is larger than 512 KiB');

    let throttled = false;
    const base = options.fetch ?? safeFetch;
    const limited: Fetcher = async (url, init) => {
      if (!takeKeyFetch(new URL(String(url)).host)) {
        throttled = true;
        throw new Error('too many actor fetches for unknown keys');
      }
      return base(url, init);
    };
    const signature = await verifyInboundSignature(request, body, { fetch: limited });
    if (!signature.ok) {
      return throttled ? refuse(429, 'slow down', retryAfter) : refuse(401, `signature: ${signature.reason}`);
    }

    let activity: unknown;
    try {
      activity = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return refuse(400, 'the body is not JSON');
    }
    const actor = isObject(activity) ? idOf(activity.actor) : null;
    if (!isObject(activity) || typeof activity.type !== 'string' || actor === null) return refuse(400, 'not an activity');
    // The key must be the actor's own: a server speaks for its own people, and nobody else's.
    if (signature.ownerApId !== actor) return refuse(401, 'signature: the key does not belong to the actor');
    // From here the sender is authenticated, so its allowance is spent by its own key only.
    const now = Date.now();
    if (!takeIntake(actor, now)) return refuse(429, 'slow down', retryAfter);
    const activityId = typeof activity.id === 'string' ? activity.id : null;
    const receipt = receiptKey(actor, body);
    if (await isRepeat(receipt, actor, activityId, now)) return new Response(null, { status: 202 });
    if (await overPendingLimit(actor)) return refuse(429, 'too much of yours is waiting to be processed', retryAfter);

    const { pathname, search } = new URL(request.url);
    const headers = { method: request.method, path: `${pathname}${search}`, signer: signature.ownerApId, keyId: signature.keyId } as Record<
      string,
      string
    >;
    for (const name of keptHeaders) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    await tx((t) =>
      t.db.insert(inboxRaw).values({
        activityId,
        activityType: activity.type as string,
        actorApId: actor,
        body,
        headers,
      }),
    );
    rememberReceipt(receipt, now);
    return new Response(null, { status: 202 });
  } catch (error) {
    console.error('inbound: could not take the activity', error);
    return refuse(503, 'try again later', retryAfter);
  }
}
