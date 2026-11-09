import { markAllNotificationsReadAs, markNotificationAs } from '@peblish/core/notifications/service';
import { inboxFilters } from '@peblish/core/notifications/view';
import type { RefusalReason } from '@peblish/schema/refusal';
import { Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';
import { forbidden, formSession, principalOf, readForm, sameOrigin } from '../../server/auth.ts';
import { inboxHref, type InboxSearch } from './-search.ts';

// The inbox's form endpoint (server only): POST /notifications with an intent. Like the comment
// forms, a plain post works without JavaScript and answers 303 back to the page the form came
// from (with ?error=<reason> on a refusal); once hydrated the page posts by fetch with
// Accept: application/json and reads { ok } or { error }.
//
// intent read or unread: id, the notice. intent read_all: no id. `filter` and `cursor` name the
// page the form came from, where the answer goes back to.

const Form = type({ intent: "'read' | 'unread'", id: 'string', 'filter?': 'string', 'cursor?': 'string' }).or({
  intent: "'read_all'",
  'filter?': 'string',
  'cursor?': 'string',
});

type Reason = RefusalReason | 'invalid';
type Outcome = { ok: true } | { ok: false; reason: Reason };

function answer(request: Request, cookies: readonly string[], outcome: Outcome, back: InboxSearch): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (request.headers.get('accept')?.includes('application/json')) {
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(outcome.ok ? { ok: true } : { error: outcome.reason }), {
      status: outcome.ok ? 200 : outcome.reason === 'auth.required' ? 401 : 400,
      headers,
    });
  }
  headers.set('location', inboxHref(outcome.ok ? back : { ...back, error: outcome.reason }));
  return new Response(null, { status: 303, headers });
}

export async function handleInboxPost(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return forbidden();
  const { session } = await formSession(request);
  const cookies = session?.setCookies ?? [];
  const form = Form(await readForm(request));
  const known = form instanceof type.errors ? undefined : form;
  const back: InboxSearch = {
    filter: inboxFilters.find((filter) => filter === known?.filter),
    cursor: known?.cursor && Uuid.allows(known.cursor) ? known.cursor : undefined,
  };
  if (!session) return answer(request, cookies, { ok: false, reason: 'auth.required' }, back);
  if (!known) return answer(request, cookies, { ok: false, reason: 'invalid' }, back);
  const principal = principalOf(session.view);
  if (known.intent === 'read_all') return answer(request, cookies, await markAllNotificationsReadAs(principal), back);
  if (!Uuid.allows(known.id)) return answer(request, cookies, { ok: false, reason: 'target.not_found' }, back);
  return answer(request, cookies, await markNotificationAs(principal, known.id, known.intent === 'read'), back);
}
