import { publicOrigin } from '@peblish/core/config';
import { savePostAs, unsavePostAs } from '@peblish/core/saves/saves';
import { type } from 'arktype';
import { forbidden, formSession, principalOf, readForm, safeRedirect, sameOrigin } from '../../server/auth.ts';
import { savedPath } from '../../shell/paths.ts';

// POST /saved: every Save and Unsave control posts here (the post page, a feed row's menu, the Saved
// page's rows). Without scripts it answers 303 back to `back` (with ?error=<reason> on a refusal);
// the enhanced controls ask for JSON and get { saved } or { error }. The owner is the session's
// person and nothing else: the form names only the post.

const Body = type({ intent: "'save' | 'unsave'", postId: 'string.uuid', 'back?': 'string <= 500' });

const wantsJson = (request: Request) => request.headers.get('accept')?.includes('application/json') ?? false;

/** `back` with ?error=<reason> added (a post page and the Saved page both show it). */
function withError(back: string, reason: string, origin: string): string {
  const url = new URL(back, origin);
  url.searchParams.set('error', reason);
  return url.pathname + url.search + url.hash;
}

export async function handleSavePost(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return forbidden();
  const json = wantsJson(request);
  const origin = publicOrigin() ?? new URL(request.url).origin;
  const fields = await readForm(request);
  const back = safeRedirect(fields.back ?? savedPath, origin);
  const { session, reply } = await formSession(request);
  if (!session)
    return json
      ? Response.json({ error: 'auth.required' }, { status: 401 })
      : reply({ redirect: `/auth/sign-in?redirect=${encodeURIComponent(back)}` });
  const body = Body(fields);
  if (body instanceof type.errors)
    return json ? Response.json({ error: 'form.invalid' }, { status: 400 }) : reply({ redirect: withError(back, 'form.invalid', origin) });

  const principal = principalOf(session.view);
  const run = body.intent === 'save' ? savePostAs : unsavePostAs;
  const result = await run(principal, { postId: body.postId });
  if (json) return result.ok ? Response.json({ saved: result.saved }) : Response.json({ error: result.reason }, { status: 400 });
  return reply({ redirect: result.ok ? back : withError(back, result.reason, origin) });
}
