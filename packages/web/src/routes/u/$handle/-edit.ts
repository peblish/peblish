import { updateProfileAs } from '@peblish/core/profiles/update';
import { type } from 'arktype';
import { forbidden, formSession, principalOf, readForm, sameOrigin } from '../../../server/auth.ts';
import { userPath } from '../../../shell/paths.ts';

// POST /u/<handle>/edit: save the display name and the bio of one's own profile. 303 back to
// the edit page with `?saved=true` or `?error=<reason>`; the enhanced form asks for JSON and gets
// `{ saved: true }` or `{ error }`.

const Body = type({ displayName: 'string <= 2000', bio: 'string <= 20000' });
const wantsJson = (request: Request) => request.headers.get('accept')?.includes('application/json') ?? false;

/** The refusals a person can meet here, as the codes profiles.json has messages for; the rest are 'generic'. */
const shown = new Set(['profile.invalid', 'auth.required', 'target.deleted']);

export async function handleEditPost(request: Request, handle: string): Promise<Response> {
  if (!sameOrigin(request)) return forbidden();
  const page = `${userPath({ handle })}/edit`;
  const json = wantsJson(request);
  const done = (error?: string) =>
    json
      ? Response.json(error ? { error } : { saved: true }, { status: error ? 400 : 200 })
      : new Response(null, { status: 303, headers: { location: error ? `${page}?error=${error}` : `${page}?saved=true` } });
  const { session, reply } = await formSession(request);
  if (!session) return reply({ redirect: `/auth/sign-in?redirect=${encodeURIComponent(page)}` });
  const body = Body(await readForm(request));
  if (body instanceof type.errors) return done('profile.invalid');
  const result = await updateProfileAs(principalOf(session.view), session.view.actorId, { displayName: body.displayName, bio: body.bio });
  return done(result.ok ? undefined : shown.has(result.reason) ? result.reason : 'generic');
}
