import { declareAgeAs } from '@peblish/core/communities/age';
import { chooseNsfw, nsfwSetCookies, parseNsfwChoice } from '@peblish/core/communities/gate';
import { findCommunityId } from '@peblish/core/communities/read';
import { followAs, unfollowAs } from '@peblish/core/follows/service';
import { localHandles } from '@peblish/core/identity/handles';
import { type } from 'arktype';
import { ageGateCookie, ageGated, forbidden, formSession, principalOf, readForm, safeRedirect, sameOrigin } from '../../server/auth.ts';
import { communityPath } from '../../shell/paths.ts';
import { secureCookies } from './-gate.ts';
import { reply, wantsJson } from './-reply.ts';

// The form posts of /c/<handle>: Join and Leave, the 16+ declaration and the Hide NSFW choices.
// Post pages post their gate forms here too, because Show once is per community. Like the other
// pages' forms: without JavaScript a post answers 303 back to `redirect` (a path on this site,
// through safeRedirect), with ?error=<reason> on a refusal; once hydrated the form posts by fetch
// with Accept: application/json and reads { ok } or { error }.

const Body = type({ intent: "'follow' | 'unfollow' | 'declare' | 'nsfw-once' | 'nsfw-always' | 'nsfw-hide'" });

/** POST /c/<handle>. */
export async function communityPost(request: Request, handle: string): Promise<Response> {
  if (!sameOrigin(request)) return forbidden();
  const { origin } = await localHandles();
  const form = await readForm(request);
  const body = Body(form);
  const back = form.redirect ? safeRedirect(form.redirect, origin) : communityPath({ handle });
  const { session } = await formSession(request);
  const cookies = session?.setCookies ?? [];
  const communityId = await findCommunityId(handle);
  if (body instanceof type.errors || !communityId) return new Response(null, { status: 404 });
  const { intent } = body;

  if (intent === 'nsfw-once' || intent === 'nsfw-always' || intent === 'nsfw-hide') {
    const choice = chooseNsfw(parseNsfwChoice(request.headers.get('cookie')), intent.slice(5) as 'once' | 'always' | 'hide', communityId);
    return reply(request, [...cookies, ...nsfwSetCookies(choice, await secureCookies())], { ok: true }, back);
  }

  if (!session) {
    if (wantsJson(request)) return reply(request, cookies, { ok: false, reason: 'auth.required' }, back);
    return new Response(null, { status: 303, headers: { location: `/auth/sign-in?redirect=${encodeURIComponent(back)}` } });
  }
  const principal = principalOf(session.view);
  if (intent === 'follow') return reply(request, cookies, await followAs(principal, communityId), back);
  if (intent === 'unfollow') return reply(request, cookies, await unfollowAs(principal, communityId), back);

  // A browser that answered under 16 in the last 24 hours may not declare again until the
  // sign-up gate's cookie runs out: the same answer as the under-16 one, and nothing is checked.
  if (ageGated(request)) return reply(request, cookies, { ok: true }, back);
  const declared = await declareAgeAs(principal, { day: form.day ?? '', month: form.month ?? '', year: form.year ?? '' });
  // Under 16: nothing is saved and this browser may not try again for 24 hours (the sign-up gate's cookie).
  if (!declared.ok && declared.reason === 'age.under_16') return reply(request, [...cookies, await ageGateCookie()], { ok: true }, back);
  return reply(request, cookies, declared, back);
}
