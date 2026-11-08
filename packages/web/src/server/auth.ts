import { auth } from '@peblish/core/identity/auth';
import { createMiddleware } from '@tanstack/react-start';
import { appendResponseHeader, getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { currentSession, type CurrentSession } from '@peblish/core/identity/session';
import type { ActingPrincipal } from '@peblish/schema/authz';
import type { SessionView } from '@peblish/schema/session';
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

/** The headers better-auth needs from the browser's request: cookies, device and address. */
export function forwardedHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of ['cookie', 'user-agent', 'x-forwarded-for', 'x-real-ip', 'accept-language']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/**
 * Refuses cross-site form posts (login CSRF, settings changes): the Origin or the fetch
 * metadata must name this host. Compared by host, since a TLS proxy in front may hand us
 * plain http. A request with neither header is not from a browser and carries no ambient
 * cookies, so it passes.
 */
export function sameOrigin(request: Request): boolean {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') return URL.canParse(origin) && new URL(origin).host === host;
  const site = request.headers.get('sec-fetch-site');
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
    return new Response(JSON.stringify(body), { status: 'redirect' in outcome ? 200 : 400, headers });
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

declare global {
  // When each user last asked for a verification link (one per minute); on globalThis like the pools.
  var peblishVerifyResends: Map<string, number> | undefined;
}

/** True, and remembered, when the user may get another verification link now. */
export function mayResendVerification(userId: string, now = Date.now()): boolean {
  const resends = (globalThis.peblishVerifyResends ??= new Map());
  const last = resends.get(userId);
  if (last !== undefined && now - last < 60_000) return false;
  resends.set(userId, now);
  return true;
}
