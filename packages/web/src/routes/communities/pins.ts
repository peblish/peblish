import { movePinAs, pinCommunityAs, unpinCommunityAs } from '@peblish/core/pins/pins';
import { Uuid } from '@peblish/schema/ids';
import { createFileRoute } from '@tanstack/react-router';
import { type } from 'arktype';
import { forbidden, formSession, principalOf, readForm, safeRedirect, sameOrigin } from '../../server/auth.ts';
import { answer, type Outcome } from './-answer.ts';

// POST /communities/pins: Pin, Unpin and Move for the sidebar's communities, from the directory's
// forms and the sidebar's row menus. Plain forms answer 303 back to `next`, the hydrated ones get
// JSON, as /communities/follow does. The owner is always the session's actor; the body only names
// the community and, for a move, its direction: one place up or down from the order as it stands
// when the move runs, never a place a page worked out from what it drew. A move's JSON answer
// carries the committed order (and the pin's place in it) for the page to draw focus from.

const Body = type({
  community: 'string',
  intent: "'pin' | 'unpin' | 'move'",
  'direction?': "'up' | 'down'",
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
        const refused = () => answer(request, cookies, { ok: false, reason: 'target.not_found' }, back);
        if (body instanceof type.errors || !Uuid.allows(body.community)) return refused();
        const principal = principalOf(session.view);
        const input = { communityId: body.community };
        if (body.intent === 'move') {
          if (body.direction === undefined) return refused();
          const moved = await movePinAs(principal, { ...input, direction: body.direction });
          const outcome: Outcome = moved.ok ? { ok: true, position: moved.position, order: moved.order } : moved;
          return answer(request, cookies, outcome, back);
        }
        const result = body.intent === 'pin' ? await pinCommunityAs(principal, input) : await unpinCommunityAs(principal, input);
        return answer(request, cookies, result.ok ? { ok: true } : result, back);
      },
    },
  },
});
