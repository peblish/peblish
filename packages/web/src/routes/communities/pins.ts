import { movePinAs, pinCommunityAs, unpinCommunityAs } from '@peblish/core/pins/pins';
import { Uuid } from '@peblish/schema/ids';
import { createFileRoute } from '@tanstack/react-router';
import { type } from 'arktype';
import { forbidden, formSession, principalOf, readForm, safeRedirect, sameOrigin } from '../../server/auth.ts';
import { answer, type Outcome } from './-answer.ts';

// POST /communities/pins: Pin, Unpin and Move for the sidebar's communities, from the directory's
// forms and the sidebar's row menus. Plain forms answer 303 back to `next`, the hydrated ones get
// JSON, as /communities/follow does. The owner is always the session's actor; the body only names
// the community and, for a move, the shown place (from 0) it goes to.

const Body = type({
  community: 'string',
  intent: "'pin' | 'unpin' | 'move'",
  // A shown place: a few digits, never more than anyone could pin.
  'to?': /^\d{1,4}$/,
  'next?': 'string',
});

export const Route = createFileRoute('/communities/pins')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session } = await formSession(request);
        const cookies = session?.setCookies ?? [];
        const form = await readForm(request);
        const back = safeRedirect(form.next, new URL(request.url).origin);
        if (!session) return answer(request, cookies, { ok: false, reason: 'auth.required' }, back);
        const body = Body(form);
        if (body instanceof type.errors || !Uuid.allows(body.community) || (body.intent === 'move' && body.to === undefined)) {
          return answer(request, cookies, { ok: false, reason: 'target.not_found' }, back);
        }
        const principal = principalOf(session.view);
        const input = { communityId: body.community };
        const result =
          body.intent === 'pin'
            ? await pinCommunityAs(principal, input)
            : body.intent === 'unpin'
              ? await unpinCommunityAs(principal, input)
              : await movePinAs(principal, { ...input, toPosition: Number(body.to) });
        const outcome: Outcome = result.ok ? { ok: true } : result;
        return answer(request, cookies, outcome, back);
      },
    },
  },
});
