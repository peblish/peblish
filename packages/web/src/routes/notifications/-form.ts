import { markAllNotificationsReadAs, markNotificationAs, undoMarkAllReadAs } from '@peblish/core/notifications/service';
import { inboxFilters, isReadBatch } from '@peblish/core/notifications/view';
import { unwatchThreadAs, watchThreadAs } from '@peblish/core/watches/watches';
import type { Result } from '@peblish/core/identity/result';
import type { RefusalReason } from '@peblish/schema/refusal';
import { Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';
import { forbidden, formSession, principalOf, readForm, sameOrigin } from '../../server/auth.ts';
import { postPath } from '../../shell/paths.ts';
import { inboxHref, markedRow, type InboxSearch } from './-search.ts';

// The inbox's form endpoint (server only): POST /notifications with an intent. Like the comment
// forms, a plain post works without JavaScript and answers 303 back to the page the form came
// from (with ?error=<reason> on a refusal); once hydrated the page posts by fetch with
// Accept: application/json and reads { ok } or { error }.
//
// intent read or unread: id, the notice. intent read_all: no id; it answers how many it marked and
// `batch`, the stamp its Undo takes, in the JSON and in the address it goes back to. intent
// undo_read_all: batch; it answers how many came back. `filter` and `cursor` name the page the
// form came from, where the answer goes back to. intent watch or unwatch: post, the thread to
// follow or stop following (the post page's Follow thread posts here, so the thread follows and
// their notices share one endpoint); it answers back to that post. The page's forms put every
// field in the action's query (inboxAction, watchAction); a field in the body wins over the same
// one in the query.

const Page = { 'filter?': 'string', 'cursor?': 'string' } as const;
const Form = type({ intent: "'read' | 'unread'", id: 'string', ...Page })
  .or({ intent: "'read_all'", ...Page })
  .or({ intent: "'undo_read_all'", batch: 'string', 'marked?': 'string', ...Page })
  .or({ intent: "'watch' | 'unwatch'", post: 'string', ...Page });

type Reason = RefusalReason | 'invalid';
type Fields = Record<string, string | number | boolean | null>;
/** What the JSON says (`fields` on success) and where a plain post goes on (`location`). */
type Outcome = { ok: true; fields?: Fields; location: string } | { ok: false; reason: Reason; location: string };

function answer(request: Request, cookies: readonly string[], outcome: Outcome): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (request.headers.get('accept')?.includes('application/json')) {
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(outcome.ok ? { ok: true, ...outcome.fields } : { error: outcome.reason }), {
      status: outcome.ok ? 200 : outcome.reason === 'auth.required' ? 401 : 400,
      headers,
    });
  }
  headers.set('location', outcome.location);
  return new Response(null, { status: 303, headers });
}

/** A core result answered back to the inbox page the form came from; `done` names what the answer adds on success. */
function back<T extends object>(
  result: Result<T>,
  page: InboxSearch,
  done: (value: T) => { fields?: Fields; page?: InboxSearch } = () => ({}),
): Outcome {
  if (!result.ok) return { ok: false, reason: result.reason, location: inboxHref({ ...page, error: result.reason }) };
  const { fields, page: next = page } = done(result);
  return { ok: true, ...(fields && { fields }), location: inboxHref(next) };
}

export async function handleInboxPost(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return forbidden();
  const { session } = await formSession(request);
  const cookies = session?.setCookies ?? [];
  const form = Form({ ...Object.fromEntries(new URL(request.url).searchParams), ...(await readForm(request)) });
  const known = form instanceof type.errors ? undefined : form;
  // A thread's answer goes back to its post, so it carries no inbox page.
  const watching = known?.intent === 'watch' || known?.intent === 'unwatch';
  const page: InboxSearch = watching
    ? {}
    : {
        filter: inboxFilters.find((filter) => filter === known?.filter),
        cursor: known?.cursor && Uuid.allows(known.cursor) ? known.cursor : undefined,
      };
  // A refused Undo goes back to its status row (its count and stamp, when both are sound), so it can be pressed again.
  const undoRow = known?.intent === 'undo_read_all' ? markedRow(known.marked, known.batch) : {};
  const refuse = (reason: Reason) =>
    answer(request, cookies, { ok: false, reason, location: inboxHref({ ...page, ...undoRow, error: reason }) });
  if (!session) return refuse('auth.required');
  if (!known) return refuse('invalid');
  const principal = principalOf(session.view);
  switch (known.intent) {
    case 'read_all': {
      const result = await markAllNotificationsReadAs(principal);
      return answer(
        request,
        cookies,
        back(result, page, ({ count, batch }) => ({
          fields: { count, batch },
          page: batch ? { ...page, marked: count, batch: Number(batch) } : page,
        })),
      );
    }
    case 'undo_read_all': {
      if (!isReadBatch(known.batch)) return refuse('invalid');
      const result = await undoMarkAllReadAs(principal, known.batch);
      return answer(
        request,
        cookies,
        back(result, { ...page, ...undoRow }, ({ count }) => ({ fields: { count }, page: { ...page, restored: count } })),
      );
    }
    case 'watch':
    case 'unwatch': {
      // The answer goes back to the post, so only an id goes into the address.
      if (!Uuid.allows(known.post)) return refuse('target.not_found');
      const thread = postPath(known.post);
      const result = await (known.intent === 'watch' ? watchThreadAs : unwatchThreadAs)(principal, { postId: known.post });
      return answer(
        request,
        cookies,
        result.ok
          ? { ok: true, fields: { watching: result.watching }, location: thread }
          : { ok: false, reason: result.reason, location: `${thread}?error=${encodeURIComponent(result.reason)}` },
      );
    }
    case 'read':
    case 'unread':
      if (!Uuid.allows(known.id)) return refuse('target.not_found');
      return answer(request, cookies, back(await markNotificationAs(principal, known.id, known.intent === 'read'), page));
  }
}
