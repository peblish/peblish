import { findCommunityId } from '@peblish/core/communities/read';
import { createCommunityAs } from '@peblish/core/communities/create';
import { updateCommunityAs } from '@peblish/core/communities/update';
import { forbidden, formSession, principalOf, sameOrigin } from '../../server/auth.ts';
import { communityPath, editCommunityPath, newCommunityPath } from '../../shell/paths.ts';
import { problemsOf, readFormValues, toPatch } from './-form.ts';
import { reply, wantsJson } from './-reply.ts';

// The community form's POST (server only): create at /c/new, edit at /c/<handle>/edit. The fields
// are judged by the same function the browser used (-form.ts), then by core, which has the last word.

export async function postCommunityForm(
  request: Request,
  target: { creating: true } | { creating: false; handle: string },
): Promise<Response> {
  if (!sameOrigin(request)) return forbidden();
  const back = target.creating ? newCommunityPath : editCommunityPath(target.handle);
  const { session } = await formSession(request);
  const cookies = session?.setCookies ?? [];
  if (!session) {
    if (wantsJson(request)) return reply(request, cookies, { ok: false, reason: 'auth.required' }, back);
    return new Response(null, { status: 303, headers: { location: `/auth/sign-in?redirect=${encodeURIComponent(back)}` } });
  }
  const principal = principalOf(session.view);
  const values = readFormValues(await request.formData());
  const problems = problemsOf(values, target.creating);
  // The name is the one problem core words itself (name.invalid); the others are fields it limits (community.invalid).
  if (problems.name) return reply(request, cookies, { ok: false, reason: 'name.invalid' }, back);
  if (Object.keys(problems).length > 0) return reply(request, cookies, { ok: false, reason: 'community.invalid' }, back);
  const patch = toPatch(values);
  if (target.creating) {
    const made = await createCommunityAs(principal, { name: values.name, ...patch });
    return made.ok ? reply(request, cookies, made, back, communityPath({ handle: made.name })) : reply(request, cookies, made, back);
  }
  const id = await findCommunityId(target.handle);
  if (!id) return new Response(null, { status: 404 });
  const saved = await updateCommunityAs(principal, id, patch);
  return reply(request, cookies, saved.ok ? { ok: true } : saved, back, communityPath({ handle: target.handle }));
}
