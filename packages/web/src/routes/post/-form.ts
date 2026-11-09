import type { RefusalReason } from '@peblish/schema/refusal';

// The post page's form answers (server only). Like lane A's pages: without JavaScript a form
// post answers 303 back to the page (with ?error=<reason> on a refusal); once hydrated the
// form posts by fetch with Accept: application/json and reads { ok } or { error }.

export type Outcome = { ok: true } | { ok: false; reason: RefusalReason };

export function answer(request: Request, cookies: readonly string[], outcome: Outcome, back: string): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (request.headers.get('accept')?.includes('application/json')) {
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(outcome.ok ? { ok: true } : { error: outcome.reason }), { status: outcome.ok ? 200 : 400, headers });
  }
  headers.set('location', outcome.ok ? back : `${back}?error=${encodeURIComponent(outcome.reason)}`);
  return new Response(null, { status: 303, headers });
}
