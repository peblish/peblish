import { auth } from '@peblish/core/identity/auth';
import { appendResponseHeader, getRequest } from '@tanstack/react-start/server';
import { currentSession, type CurrentSession } from '@peblish/core/identity/session';
import type { ActingPrincipal } from '@peblish/schema/authz';
import type { SessionView } from '@peblish/schema/session';
import type { FormError } from '../routes/auth/-ui/errors.ts';

// Lane A's server glue between the auth pages and core (better-auth lives in
// core/identity/auth.ts). Only route server handlers and server functions import this
// module, so none of it reaches the client bundle.
//
// The pages are plain HTML forms that POST to their own route. Without JavaScript the
// handler answers 303 to the next page, or back with ?error=<code>; the enhanced form
// (routes/auth/-ui/form.tsx) sends Accept: application/json and gets { redirect } or
// { error } instead, keeping what was typed.

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
  const headers = new Headers({ 'cache-control': 'no-store' });
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

/** The session for a form handler; null when signed out. */
export function sessionOf(request: Request): Promise<CurrentSession | null> {
  return currentSession(forwardedHeaders(request));
}

/**
 * The session for a page's server function, passing on the cookie better-auth refreshes
 * once a day (session.updateAge), so an active session's cookie keeps up with its row.
 */
export async function pageSession(): Promise<CurrentSession | null> {
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

/** Only a path on this site: an open redirect would turn the sign-in page into a phishing aid. */
export const safeRedirect = (target: string | undefined) => (target && /^\/(?!\/)/.test(target) && !target.includes('\\') ? target : '/');

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
