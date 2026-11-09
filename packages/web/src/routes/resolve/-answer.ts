import type { ResolveError } from '@peblish/core/resolve/outcome';

// The resolve form's answers (server only). Without JavaScript a post answers 303 to the local
// page that now holds the thing, or back to /resolve with ?error=<code>&q=<what was typed>; once
// hydrated the form posts by fetch with Accept: application/json and reads { redirect } or { error }.

export type Outcome = { ok: true; redirect: string } | { ok: false; error: ResolveError };

export function answer(request: Request, cookies: readonly string[], outcome: Outcome, q: string): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (request.headers.get('accept')?.includes('application/json')) {
    headers.set('content-type', 'application/json');
    const status = outcome.ok ? 200 : outcome.error === 'rate.limited' ? 429 : 400;
    return new Response(JSON.stringify(outcome.ok ? { redirect: outcome.redirect } : { error: outcome.error }), { status, headers });
  }
  if (outcome.ok) headers.set('location', outcome.redirect);
  else {
    const back = new URLSearchParams({ error: outcome.error });
    if (q !== '') back.set('q', q);
    headers.set('location', `/resolve?${back}`);
  }
  return new Response(null, { status: 303, headers });
}
