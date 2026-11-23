import { recordVisitAs } from '@peblish/core/visits/visits';
import { Uuid } from '@peblish/schema/ids';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { PRIVATE_NO_STORE, forbidden, formSession, principalOf, sameOrigin } from '../../../server/auth.ts';

// POST /post/<id>/visit: records that the signed-in person opened the thread ("new since last
// visit", core visits/). The post page sends it once its thread is on screen
// (comments/-ui/new-since.tsx), so the write never rides on a page read: a GET or a HEAD (a
// prefetch, a preload, a link preview, a crawler) is sent on to the post's page and records
// nothing, a cross-site POST is refused, and without a session nothing happens. It answers 204
// either way; the page does not read the answer.

export const Route = createFileRoute('/post/$id/visit')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/post/$id', params: { id: params.id } });
  },
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session } = await formSession(request);
        const headers = new Headers({ 'cache-control': PRIVATE_NO_STORE });
        for (const cookie of session?.setCookies ?? []) headers.append('set-cookie', cookie);
        if (session && Uuid.allows(params.id)) await recordVisitAs(principalOf(session.view), { postId: params.id });
        return new Response(null, { status: 204, headers });
      },
    },
  },
});
