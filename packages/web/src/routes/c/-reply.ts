import type { RefusalReason } from '@peblish/schema/refusal';

// How the community pages' form posts answer, like the post page's and the composer's: without
// JavaScript a 303 (to `to` when it worked, back to `back` with ?error=<reason> when it did not),
// once hydrated JSON: { ok, redirect } or { error }.

export type Outcome = { ok: true } | { ok: false; reason: RefusalReason };

export const wantsJson = (request: Request) => request.headers.get('accept')?.includes('application/json') ?? false;

/** `back` with ?error=<reason> set (and any query it had kept). */
export function withError(back: string, reason: string): string {
  const url = new URL(back, 'http://local');
  url.searchParams.set('error', reason);
  return url.pathname + url.search + url.hash;
}

export function reply(request: Request, cookies: readonly string[], outcome: Outcome, back: string, to: string = back): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (wantsJson(request)) {
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(outcome.ok ? { ok: true, redirect: to } : { error: outcome.reason }), {
      status: outcome.ok ? 200 : 400,
      headers,
    });
  }
  headers.set('location', outcome.ok ? to : withError(back, outcome.reason));
  return new Response(null, { status: 303, headers });
}
