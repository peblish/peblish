// The federation side of HTTP, the only federation module web imports besides the consumer
// registry (lint rule web-federation-entry-points). G0 created it; lane FED-A owns it.

/** Paths federation always answers: ActivityPub endpoints, WebFinger and NodeInfo. */
const federationPaths = [
  /^\/ap\//,
  /^\/\.well-known\/(webfinger|nodeinfo)$/,
  /^\/nodeinfo\//,
  /^\/(inbox|outbox)$/,
  /^\/[uc]\/[^/]+\/(inbox|outbox)$/,
];
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

/**
 * Answers a federation request (Fedify's federation.fetch, lane FED-A). Null means "not
 * mine": web then renders the UI route, so a page path falls back to HTML.
 */
export async function handleFederationRequest(_request: Request): Promise<Response | null> {
  return null;
}
