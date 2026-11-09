import { createCommentAs, deleteCommentAs, updateCommentAs } from '@peblish/core/comments/actions';
import { NewComment } from '@peblish/core/comments/input';
import { attempt } from '@peblish/core/identity/throttle';
import type { RefusalReason } from '@peblish/schema/refusal';
import { Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';
import { commentPath, postPath } from '../../../../shell/paths.ts';
import { forbidden, formSession, principalOf, readForm, sameOrigin } from '../../../../server/auth.ts';

// The comment forms' endpoint (server only): POST /post/<id>/comments with an intent. Like the
// post page and lane A's pages, a plain form post works without JavaScript and answers 303 back
// to the page (with ?commentError=<code> on a refusal); once hydrated the reply bar posts by
// fetch with Accept: application/json and reads { ok } or { error }.
//
// intent reply: body, and parent (a comment id; empty replies to the post);
// intent edit: comment and body; intent delete: comment.
// focus (a comment id) names the permalink page the form came from, where the answer goes back to.
// Each form post is counted against the account's `comment` budget (30 in ten minutes) before
// it does anything; over it the answer is rate.limited (429 for the enhanced form).

const Form = type({ intent: "'reply'", body: 'string', 'parent?': 'string', 'focus?': 'string' })
  .or({ intent: "'edit'", comment: 'string', body: 'string', 'focus?': 'string' })
  .or({ intent: "'delete'", comment: 'string', 'focus?': 'string' });

type Reason = RefusalReason | 'invalid' | 'rate.limited';
type Outcome = { ok: true; id?: string } | { ok: false; reason: Reason };

const refuse = (reason: Reason): Outcome => ({ ok: false, reason });

function answer(request: Request, cookies: readonly string[], outcome: Outcome, back: string): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (request.headers.get('accept')?.includes('application/json')) {
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(outcome.ok ? { ok: true, id: outcome.id } : { error: outcome.reason }), {
      status: outcome.ok ? 200 : outcome.reason === 'rate.limited' ? 429 : 400,
      headers,
    });
  }
  headers.set(
    'location',
    outcome.ok
      ? `${back}${outcome.id ? `#comment-${outcome.id}` : ''}`
      : `${back}?commentError=${encodeURIComponent(outcome.reason)}#comments`,
  );
  return new Response(null, { status: 303, headers });
}

export async function handleCommentPost(request: Request, postId: string): Promise<Response> {
  if (!sameOrigin(request)) return forbidden();
  const { session } = await formSession(request);
  const cookies = session?.setCookies ?? [];
  const form = Form(await readForm(request));
  const focus = form instanceof type.errors || !form.focus || !Uuid.allows(form.focus) ? null : form.focus;
  // The post id is the address's: nothing is built from it, least of all a redirect, until it is known to be an id.
  const back = !Uuid.allows(postId) ? '/' : focus ? commentPath(postId, focus) : postPath(postId);
  if (!session) return answer(request, cookies, refuse('auth.required'), back);
  if (form instanceof type.errors || !Uuid.allows(postId)) return answer(request, cookies, refuse('target.not_found'), back);
  const principal = principalOf(session.view);
  const comment = 'comment' in form ? form.comment : '';
  if (form.intent !== 'reply' && !Uuid.allows(comment)) return answer(request, cookies, refuse('target.not_found'), back);
  if (!(await attempt('comment', { id: principal.actorId })).allowed) return answer(request, cookies, refuse('rate.limited'), back);
  let outcome: Outcome;
  switch (form.intent) {
    case 'reply': {
      const input = NewComment({ bodyMd: form.body });
      const parentId = form.parent ? form.parent : null;
      if (input instanceof type.errors) outcome = refuse('invalid');
      else if (parentId !== null && !Uuid.allows(parentId)) outcome = refuse('target.not_found');
      else outcome = await createCommentAs(principal, { postId, parentId }, input);
      break;
    }
    case 'edit': {
      const input = NewComment({ bodyMd: form.body });
      outcome = input instanceof type.errors ? refuse('invalid') : await updateCommentAs(principal, comment, input);
      break;
    }
    case 'delete':
      outcome = await deleteCommentAs(principal, comment);
      break;
  }
  return answer(request, cookies, outcome, back);
}
