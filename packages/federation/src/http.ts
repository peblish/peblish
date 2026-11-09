// The federation side of HTTP, the only federation module web imports besides the consumer
// registry (lint rule web-federation-entry-points). G0 created it; lane FED-A owns it.

import { db } from '@peblish/core/db/read';
import { localDocument } from './actors/serve.ts';
import { localOrigin } from './federation.ts';
import { receiveInbound } from './inbound/receive.ts';
import { serveNodeInfo } from './nodeinfo/serve.ts';
import { serveWebFinger } from './webfinger/serve.ts';

/** Paths federation always answers: ActivityPub endpoints, WebFinger and NodeInfo. */
const federationPaths = [
  /^\/ap\//,
  /^\/\.well-known\/(webfinger|nodeinfo)$/,
  /^\/nodeinfo\//,
  /^\/(inbox|outbox)$/,
  // The imported actors keep their /u/<name> and /c/<name> ids, so their collections sit below the page path.
  /^\/[uc]\/[^/]+\/(inbox|outbox|followers|featured|moderators)$/,
];
/** Every inbox: the shared one, a new actor's (below /ap/) and an imported actor's (below its page path). */
const inboxPaths = [/^\/inbox$/, /^\/ap\/[uc]\.[^/]+\/inbox$/, /^\/[uc]\/[^/]+\/inbox$/];
/** Pages that are also ActivityPub objects (the instance actor, users, communities), chosen by Accept. */
const negotiatedPaths = [/^\/$/, /^\/[uc]\/[^/]+$/];

const activityTypes = new Set(['application/activity+json', 'application/ld+json']);

/** True when the Accept header prefers ActivityPub JSON to HTML. q=0 means "not acceptable". */
export function prefersActivityJson(accept: string | null): boolean {
  let activity = 0;
  let html = 0;
  for (const range of (accept ?? '').split(',')) {
    const [type = '', ...params] = range.split(';').map((part) => part.trim().toLowerCase());
    const q = params.find((param) => param.startsWith('q='));
    const quality = q ? Number(q.slice(2)) : 1;
    if (!Number.isFinite(quality)) continue;
    if (activityTypes.has(type)) activity = Math.max(activity, quality);
    if (type === 'text/html') html = Math.max(html, quality);
  }
  return activity > 0 && activity >= html;
}

/** True for a page path whose response depends on Accept (the bridge adds Vary: Accept). */
export function negotiatesByAccept(pathname: string): boolean {
  return negotiatedPaths.some((path) => path.test(pathname));
}

/** True for requests the bridge hands to handleFederationRequest before any UI route. */
export function isFederationRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  if (federationPaths.some((path) => path.test(pathname))) return true;
  return negotiatesByAccept(pathname) && prefersActivityJson(request.headers.get('accept'));
}

/** Seconds a peer waits before retrying when the database is out of reach. */
const retryAfterSeconds = 60;

const activityJson = 'application/activity+json; charset=utf-8';

function jsonResponse(status: number, json: object): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': activityJson, 'cache-control': 'public, max-age=60' },
  });
}

async function answer(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (inboxPaths.some((path) => path.test(pathname))) {
    if (request.method === 'POST') return receiveInbound(request);
    return new Response('inboxes take POST', { status: 405, headers: { Allow: 'POST' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // A page path that is not ours to refuse: the UI decides what a POST to it means.
    if (negotiatesByAccept(pathname)) return null;
    return new Response('read only', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const origin = await localOrigin();
  if (pathname === '/.well-known/webfinger') return serveWebFinger(db(), origin, url);
  if (pathname === '/.well-known/nodeinfo' || pathname.startsWith('/nodeinfo/')) return serveNodeInfo(db(), origin, pathname);
  const served = await localDocument(db(), origin, pathname);
  if (served) return jsonResponse(served.status, served.json);
  // A page path nobody here owns is the UI's to render (its own not-found page); the rest of
  // ours is plain: there is no such document.
  return negotiatesByAccept(pathname) ? null : new Response('not found', { status: 404 });
}

/**
 * Answers a federation request: inbox POSTs go to the inbound pipeline, everything else is
 * read-only documents built from the database (WebFinger, NodeInfo, actors, collections,
 * posts, comments and activities). Null means "not mine": web then renders the UI route, so a
 * page path falls back to HTML. A failure we did not expect, a database outage for one, is a
 * 503 with Retry-After, the one error answer peers retry; it is never a 500, which peers read
 * as a broken server, and never a 410, which they read as a deleted actor.
 */
export async function handleFederationRequest(request: Request): Promise<Response | null> {
  try {
    const response = await answer(request);
    // HEAD gets the headers of the GET and no body.
    if (response && request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
    return response;
  } catch (error) {
    console.error(`federation: ${request.method} ${new URL(request.url).pathname} failed`, error);
    return new Response('try again later', { status: 503, headers: { 'Retry-After': String(retryAfterSeconds) } });
  }
}
