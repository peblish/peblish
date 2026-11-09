import { inboxRaw } from '@peblish/core/db/tables/federation';
import { readSetting } from '@peblish/core/settings/read';
import { tx } from '@peblish/core/tx/tx';
import type { Fetcher } from '../actors/document.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import { verifyInboundSignature } from '../signing/inbound.ts';
import { takeKeyFetch } from './throttle.ts';

// The inbox's front door (lane FED-A's http.ts routes every inbox POST here). It does the
// least that is safe and answers fast; applying the activity is the pipeline's, a moment later
// in the worker (pipeline.ts):
//
//   inbox.enabled off  503 + Retry-After   the one maintenance answer an inbox may give
//   body over 512 KiB  413                 by Content-Length, or counted as a chunked body streams in
//   bad signature      401                 draft-cavage, the key's owner is the activity's actor
//   not an activity    400
//   throttled          429 + Retry-After   too many unknown keys at once
//   stored             202                 the exact bytes, in inbox_raw
//
// Never 410 (peers read it as "this actor is gone"), 418 or an unexpected 5xx: a failure we did
// not expect, a storage error included, is the 503 peers retry.

export const maxBodyBytes = 512 * 1024;
const retryAfter = { 'Retry-After': '300' };
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
        activityId: typeof activity.id === 'string' ? activity.id : null,
        activityType: activity.type as string,
        actorApId: actor,
        body,
        headers,
      }),
    );
    return new Response(null, { status: 202 });
  } catch (error) {
    console.error('inbound: could not take the activity', error);
    return refuse(503, 'try again later', retryAfter);
  }
}
