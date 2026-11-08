import { auth } from '@peblish/core/identity/auth';
import { createFileRoute } from '@tanstack/react-router';
import { forbidden, forwardedHeaders, respond, sameOrigin, signedOutCookies } from '../../server/auth.ts';

// POST /auth/sign-out from any page's sign-out button (a form with this action).
export const Route = createFileRoute('/auth/sign-out')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        try {
          const { headers } = await (await auth()).api.signOut({ headers: forwardedHeaders(request), returnHeaders: true });
          return respond(request, { redirect: '/', cookies: headers.getSetCookie() });
        } catch {
          // No session left (revoked elsewhere): clear the cookies anyway.
          return respond(request, { redirect: '/', cookies: await signedOutCookies() });
        }
      },
    },
  },
});
