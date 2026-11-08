import { auth } from '@peblish/core/identity/auth';
import { currentSession, type CurrentSession } from '@peblish/core/identity/session';
import { attempt } from '@peblish/core/identity/throttle';
import { lookupInvite } from '@peblish/core/registration/invites';
import type { ActingPrincipal } from '@peblish/schema/authz';
import type { InviteLookup } from '@peblish/schema/invite';
import type { SessionView } from '@peblish/schema/session';
import { createMiddleware } from '@tanstack/react-start';
import { appendResponseHeader, getRequest, getRequestIP, setResponseHeader } from '@tanstack/react-start/server';
import { type } from 'arktype';
import type { FormError } from '../routes/auth/-ui/errors.ts';
import { editable } from './fetch.ts';

// Lane A's server glue between the auth pages and core (better-auth lives in
// core/identity/auth.ts). Only route server handlers and server functions import this
// module, so none of it reaches the client bundle.
//
// The pages are plain HTML forms that POST to their own route. Without JavaScript the
// handler answers 303 to the next page, or back with ?error=<code>; the enhanced form
// (routes/auth/-ui/form.tsx) sends Accept: application/json and gets { redirect } or
// { error } instead, keeping what was typed.

/** For a response that depends on who asks, or carries a bearer secret (a reset token, an invite code). */
export const PRIVATE_NO_STORE = 'private, no-store';

/** `response` with cache-control: private, no-store; a copy when its headers cannot change. */
export function privateResponse(response: Response): Response {
  try {
    response.headers.set('cache-control', PRIVATE_NO_STORE);
    return response;
  } catch {
    const copy = editable(response);
    copy.headers.set('cache-control', PRIVATE_NO_STORE);
    return copy;
  }
}

/**
 * The cache rule for every response under /auth, /invite, /settings and /admin, in one place:
 * each of those route groups' route.tsx runs it, for pages, form posts and redirects alike.
 */
export const privateResponses = createMiddleware().server(async ({ next }) => {
  const result = await next();
  return { ...result, response: privateResponse(result.response) };
});

/** Which proxy in front may name the client (PEBLISH_TRUSTED_PROXY, deploy/README.md); none by default. */
export const TrustedProxy = type("'none' | 'traefik' | 'cloudflare'");

function trustedProxy(): typeof TrustedProxy.infer {
  const proxy = TrustedProxy(process.env.PEBLISH_TRUSTED_PROXY ?? 'none');
  if (proxy instanceof type.errors) throw new Error(`PEBLISH_TRUSTED_PROXY: ${proxy.summary}`);
  return proxy;
}

/**
 * The client's address, from a header only when the setting names the proxy that sets it:
 * Cloudflare's CF-Connecting-IP, or the entry Traefik appended last to X-Forwarded-For (any
 * before it came from the client). Otherwise, and when that header is missing, the peer.
 */
export function clientAddress(headers: Headers, proxy: typeof TrustedProxy.infer, peer: string | undefined): string | null {
  const named =
    proxy === 'cloudflare'
      ? headers.get('cf-connecting-ip')
      : proxy === 'traefik'
        ? headers.get('x-forwarded-for')?.split(',').at(-1)
        : null;
  return named?.trim() || peer || null;
}

/** The address of the client sending `request` (the handler's own request). */
export const clientIp = (request: Request) => clientAddress(request.headers, trustedProxy(), getRequestIP());

/**
 * The headers better-auth needs from the browser's request: cookies, device, and the client's
 * address as clientIp() sees it, so a session never records an address the client made up.
 */
export function forwardedHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of ['cookie', 'user-agent', 'accept-language']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const ip = clientIp(request);
  if (ip) headers.set('x-forwarded-for', ip);
  return headers;
}

/**
 * An invite code looked up for a page, counted against the client's budget of codes that
 * match no invite (identity/throttle.ts); null when the client is over it.
 */
export async function lookupInviteFor(request: Request, code: string): Promise<InviteLookup | null> {
  const counted = await attempt('invite-code', { ip: clientIp(request) });
  if (!counted.allowed) return null;
  const invite = await lookupInvite(code);
  if (invite.status !== 'unknown') await counted.refund();
  return invite;
}

/**
 * Refuses cross-site form posts (login CSRF, settings changes): the Origin or the fetch
 * metadata must name this host. Compared by host, since a TLS proxy in front may hand us
 * plain http. An opaque Origin ('null': a sandboxed frame, a data: URL) passes only with
 * same-origin fetch metadata. A request with neither header is not from a browser and
 * carries no ambient cookies, so it passes.
 */
export function sameOrigin(request: Request): boolean {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (origin === 'null') return site === 'same-origin';
  if (origin) return URL.canParse(origin) && new URL(origin).host === host;
  return site === null || site === 'same-origin';
}

/** The form's fields as strings (files and repeats ignored). */
export async function readForm(request: Request): Promise<Record<string, string>> {
  const fields: Record<string, string> = {};
  const data = await request.formData();
  for (const [name, value] of data) if (typeof value === 'string' && !(name in fields)) fields[name] = value;
  return fields;
}

const wantsJson = (request: Request) => request.headers.get('accept')?.includes('application/json') ?? false;

type Outcome = {
  /** Set-Cookie values to send (from better-auth, or our own). */
  cookies?: string[];
} & ({ redirect: string } | { error: FormError; back: string; keep?: Record<string, string | undefined> });

/** The form handler's answer: JSON for the enhanced form, otherwise 303 (PRG). */
export function respond(request: Request, outcome: Outcome): Response {
  const headers = new Headers();
  for (const cookie of outcome.cookies ?? []) headers.append('set-cookie', cookie);
  let location: string;
  if ('redirect' in outcome) location = outcome.redirect;
  else {
    const back = new URL(outcome.back, 'http://local');
    back.searchParams.set('error', outcome.error);
    for (const [name, value] of Object.entries(outcome.keep ?? {})) if (value) back.searchParams.set(name, value);
    location = back.pathname + back.search;
  }
  if (wantsJson(request)) {
    headers.set('content-type', 'application/json');
    const body = 'redirect' in outcome ? { redirect: outcome.redirect } : { error: outcome.error };
    const status = 'redirect' in outcome ? 200 : outcome.error === 'rate.limited' ? 429 : 400;
    return new Response(JSON.stringify(body), { status, headers });
  }
  headers.set('location', location);
  return new Response(null, { status: 303, headers });
}

/** 403 for a cross-site post. */
export const forbidden = () =>
  new Response('cross-site form posts are refused\n', { status: 403, headers: { 'content-type': 'text/plain' } });

/** The session for a request's cookies; null when signed out. */
const sessionOf = (request: Request): Promise<CurrentSession | null> => currentSession(forwardedHeaders(request));

/** A form handler's session (null when signed out) and its reply. */
export type FormSession = { session: CurrentSession | null; reply: (outcome: Outcome) => Response };

/**
 * The session for a form handler, with reply(): respond() passing on the cookie better-auth
 * refreshed while reading the session (session.updateAge), so someone who only posts forms
 * keeps a cookie as fresh as their session row. The outcome's own cookies come after it, so a
 * newer session (a changed password) or a sign-out wins.
 */
export async function formSession(request: Request): Promise<FormSession> {
  return withSession(request, await sessionOf(request));
}

export function withSession(request: Request, session: CurrentSession | null): FormSession {
  const refreshed = session?.setCookies ?? [];
  return { session, reply: (outcome) => respond(request, { ...outcome, cookies: [...refreshed, ...(outcome.cookies ?? [])] }) };
}

/**
 * The session for a page's server function, passing on the cookie better-auth refreshes
 * once a day (session.updateAge), so an active session's cookie keeps up with its row. What
 * it answers depends on the cookie, so it is never cached: the route groups' middleware says
 * so for their pages, and this for the server function's own reply on a client-side
 * navigation and for any page elsewhere that shows the signed-in person.
 */
export async function pageSession(): Promise<CurrentSession | null> {
  setResponseHeader('cache-control', PRIVATE_NO_STORE);
  const session = await sessionOf(getRequest());
  for (const cookie of session?.setCookies ?? []) appendResponseHeader('set-cookie', cookie);
  return session;
}

/** The principal a signed-in person acts as. */
export const principalOf = (view: SessionView): ActingPrincipal => ({ kind: 'local', actorId: view.actorId, siteRole: view.siteRole });

/** Cookies that sign the browser out, for when its session is already gone (deletion). */
export async function signedOutCookies(): Promise<string[]> {
  const { authCookies } = await (await auth()).$context;
  return [authCookies.sessionToken, authCookies.sessionData, authCookies.dontRememberToken].map(
    ({ name, attributes }) =>
      `${name}=; Path=${attributes.path ?? '/'}; Max-Age=0; HttpOnly; SameSite=Lax${attributes.secure ? '; Secure' : ''}`,
  );
}

/**
 * Sign-up's 16+ gate: an under-16 answer blocks sign-up from this browser for 24 hours
 * (decision 2026-11-08). A reasonable step, not a control: clearing cookies removes it.
 */
export const AGE_GATE_COOKIE = 'peblish.age_gate';

/** Secure whenever better-auth's own cookies are (an https instance origin). */
export async function ageGateCookie(): Promise<string> {
  const { authCookies } = await (await auth()).$context;
  const secure = authCookies.sessionToken.attributes.secure ? '; Secure' : '';
  return `${AGE_GATE_COOKIE}=1; Path=/; Max-Age=${24 * 60 * 60}; HttpOnly; SameSite=Lax${secure}`;
}

export function ageGated(request: Request): boolean {
  return (request.headers.get('cookie') ?? '').split(/;\s*/).includes(`${AGE_GATE_COOKIE}=1`);
}

const hasControlCharacter = (text: string) => [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/**
 * Where to go after signing in: a path on this site, else '/'. An open redirect would turn the
 * sign-in page into a phishing aid, and browsers drop tabs and line breaks from a URL, so
 * `/\t/evil.example` would become `//evil.example`. So a control character or a backslash
 * anywhere refuses it, it must start with one slash, and resolved against the instance's
 * origin it must stay there.
 */
export function safeRedirect(target: string | undefined, origin: string): string {
  if (!target || hasControlCharacter(target) || target.includes('\\') || !/^\/(?!\/)/.test(target)) return '/';
  const url = new URL(target, origin);
  return url.origin === new URL(origin).origin ? url.pathname + url.search + url.hash : '/';
}
