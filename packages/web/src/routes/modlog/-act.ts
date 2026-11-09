import type { RefusalReason } from '@peblish/schema/refusal';
import { type } from 'arktype';

// The moderator forms' side of POST /modlog/act (server only): the body, the inputs it makes,
// and how a result is answered. Without JavaScript a form post answers 303 back to the page it
// came from (with ?modError=<code>&modFor=<panel> on a refusal, which opens that panel again);
// once hydrated the form posts by fetch with Accept: application/json and reads { ok } or { error }.

export const Body = type({
  intent: "'remove' | 'restore' | 'ban' | 'unban' | 'site_ban' | 'site_unban'",
  'kind?': "'post' | 'comment'",
  'id?': 'string.uuid',
  'community?': 'string.uuid',
  'person?': 'string.uuid',
  'reason?': 'string',
  /** A checkbox: present (any value) means the reason is shown in the public modlog. */
  'public?': 'string',
  'duration?': "'1' | '7' | '30' | 'permanent' | 'custom'",
  'until?': 'string',
  /** A checkbox: also remove the person's content. */
  'removeContent?': 'string',
  'back?': 'string',
});
export type Body = typeof Body.infer;

/** Codes only the web layer raises. */
export type ActError = RefusalReason | 'form.invalid' | 'reason.required';

export type Outcome = { ok: true } | { ok: false; reason: ActError };

const DAY = 86_400_000;

/**
 * When the ban ends: the chosen number of days from now, a custom day (its last second, UTC), or
 * null for a permanent ban. `undefined` when the choice cannot be read or is not in the future.
 */
export function banEnd(body: Pick<Body, 'duration' | 'until'>, now = Date.now()): string | null | undefined {
  const { duration = 'permanent', until } = body;
  if (duration === 'permanent') return null;
  if (duration === 'custom') {
    if (!until || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return undefined;
    const end = Date.parse(`${until}T23:59:59.000Z`);
    return Number.isNaN(end) || end <= now ? undefined : new Date(end).toISOString();
  }
  return new Date(now + Number(duration) * DAY).toISOString();
}

/** The reason as the form gave it: trimmed, null when empty; undefined when over the limit. */
export function readReason(raw: string | undefined): string | null | undefined {
  const reason = raw?.trim() ?? '';
  if (reason.length > 10_000) return undefined;
  return reason === '' ? null : reason;
}

export const needsReason = (intent: Body['intent']) => intent === 'remove' || intent === 'ban' || intent === 'site_ban';

/** The page to go back to, with the form's error (or none) in its query: modFor names the panel to open again. */
export function backTo(back: string, outcome: Outcome, panel: string): string {
  const url = new URL(back, 'http://local');
  url.searchParams.delete('modError');
  url.searchParams.delete('modFor');
  if (!outcome.ok) {
    url.searchParams.set('modError', outcome.reason);
    url.searchParams.set('modFor', panel);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function answer(request: Request, cookies: readonly string[], outcome: Outcome, back: string, panel: string): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (request.headers.get('accept')?.includes('application/json')) {
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(outcome.ok ? { ok: true } : { error: outcome.reason }), { status: outcome.ok ? 200 : 400, headers });
  }
  headers.set('location', backTo(back, outcome, panel));
  return new Response(null, { status: 303, headers });
}
