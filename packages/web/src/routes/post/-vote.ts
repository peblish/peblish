import { voteAs } from '@peblish/core/votes/service';
import { ContentRef } from '@peblish/schema/ids';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { pageSession, principalOf, sameOrigin } from '../../server/auth.ts';

/**
 * Casts, changes or takes back the signed-in person's vote on a post or a comment: lanes C1
 * (feed cards) and D (comments) call it as `castVoteFn({ data: { target, value } })`. value is
 * 1, -1, or 0 for taking the vote back. It answers with the vote held and the tally, so the
 * caller can settle on the server's numbers, or with the refusal (a result, never a throw:
 * signed out is 'auth.required').
 */
export const castVoteFn = createServerFn({ method: 'POST' })
  .validator(type({ target: ContentRef, value: '-1 | 0 | 1' }))
  .handler(async ({ data }) => {
    const session = sameOrigin(getRequest()) ? await pageSession() : null;
    if (!session) return { ok: false, reason: 'auth.required' } as const;
    return voteAs(principalOf(session.view), data.target, data.value);
  });
