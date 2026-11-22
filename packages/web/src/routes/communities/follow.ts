import { readCommunity } from '@peblish/core/communities/read';
import { joinCommunityAs, leaveCommunityAs } from '@peblish/core/directory/follow';
import { Uuid } from '@peblish/schema/ids';
import { createFileRoute } from '@tanstack/react-router';
import { type } from 'arktype';
import { forbidden, formSession, principalOf, readForm, safeRedirect, sameOrigin } from '../../server/auth.ts';
import { answer, type Outcome } from './-answer.ts';

// POST /communities/follow: the directory's Join and Leave (and any page that wants them). Plain
// forms answer 303 back to `next`, the hydrated ones get JSON; the work is core's followAs and
// unfollowAs, which authorize and answer with the reason a refusal has.

const Body = type({ community: 'string', intent: "'join' | 'leave'", 'next?': 'string' });

/**
 * A Leave or Cancel that finds no follow to remove, in a community that is there, did what it was asked: the person is
 * not in the community. So a second press, a retry or a request already gone answers as done. A community that is not
 * there (a made-up id, or one deleted or removed since) stays not found, and any other refusal stands.
 */
async function leftAnyway(outcome: Outcome, community: Uuid): Promise<Outcome> {
  if (outcome.ok || outcome.reason !== 'target.not_found') return outcome;
  return (await readCommunity({ id: community })) ? { ok: true } : outcome;
}

export const Route = createFileRoute('/communities/follow')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session } = await formSession(request);
        const cookies = session?.setCookies ?? [];
        const form = await readForm(request);
        // `next` goes into the Location header: only a path on this site does.
        const back = safeRedirect(form.next, new URL(request.url).origin);
        if (!session) return answer(request, cookies, { ok: false, reason: 'auth.required' }, back);
        const body = Body(form);
        if (body instanceof type.errors || !Uuid.allows(body.community)) {
          return answer(request, cookies, { ok: false, reason: 'target.not_found' }, back);
        }
        const principal = principalOf(session.view);
        const outcome: Outcome =
          body.intent === 'join'
            ? await joinCommunityAs(principal, body.community)
            : await leftAnyway(await leaveCommunityAs(principal, body.community), body.community);
        return answer(request, cookies, outcome, back);
      },
    },
  },
});
