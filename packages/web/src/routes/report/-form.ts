import type { ReportError } from './-ui/errors.ts';

// The report pages' form answers (server only). Like lane A's pages: without JavaScript a form
// post answers 303 to the next page, or back with ?error=<code>; once hydrated the form posts
// by fetch with Accept: application/json and reads { redirect } or { error }.

export type Outcome = { redirect: string } | { error: ReportError; back: string; keep?: Record<string, string | undefined> };

export function answer(request: Request, cookies: readonly string[], outcome: Outcome): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  let location: string;
  if ('redirect' in outcome) location = outcome.redirect;
  else {
    const back = new URL(outcome.back, 'http://local');
    back.searchParams.set('error', outcome.error);
    for (const [name, value] of Object.entries(outcome.keep ?? {})) if (value) back.searchParams.set(name, value);
    location = back.pathname + back.search;
  }
  if (request.headers.get('accept')?.includes('application/json')) {
    headers.set('content-type', 'application/json');
    const body = 'redirect' in outcome ? { redirect: outcome.redirect } : { error: outcome.error };
    const status = 'redirect' in outcome ? 200 : outcome.error === 'rate.limited' ? 429 : 400;
    return new Response(JSON.stringify(body), { status, headers });
  }
  headers.set('location', location);
  return new Response(null, { status: 303, headers });
}
