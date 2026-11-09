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
          body.intent === 'join' ? await joinCommunityAs(principal, body.community) : await leaveCommunityAs(principal, body.community);
        return answer(request, cookies, outcome, back);
      },
    },
  },
});
