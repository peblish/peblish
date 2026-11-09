import type { RefusalReason } from '@peblish/schema/refusal';

// The join and leave forms' answers (server only). Like the post page's: without JavaScript a
// form post answers 303 back to the page it came from (with ?error=<reason> on a refusal); once
// hydrated the form posts by fetch with Accept: application/json and reads { ok } or { error }.

export type Outcome = { ok: true } | { ok: false; reason: RefusalReason };

/** `back` with `error=<reason>` set, keeping the rest of its query (a directory's sort and search). */
export function backWithError(back: string, reason: string): string {
  const url = new URL(back, 'http://local');
  url.searchParams.set('error', reason);
  return url.pathname + url.search;
}

export function answer(request: Request, cookies: readonly string[], outcome: Outcome, back: string): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (request.headers.get('accept')?.includes('application/json')) {
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(outcome.ok ? { ok: true } : { error: outcome.reason }), { status: outcome.ok ? 200 : 400, headers });
  }
  headers.set('location', outcome.ok ? back : backWithError(back, outcome.reason));
  return new Response(null, { status: 303, headers });
}
