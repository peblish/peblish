import { deletePostAs, restorePostAs } from '@peblish/core/posts/actions';
import { Uuid } from '@peblish/schema/ids';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { type } from 'arktype';
import { forbidden, formSession, principalOf, readForm, sameOrigin } from '../../../server/auth.ts';
import { loadPost } from '../-load.ts';
import { answer, type Outcome } from '../-form.ts';
import { PostPage } from '../-ui/post-page.tsx';
import postCss from '../-ui/post.css?url';
import gateCss from '../../c/-ui/gate.css?url';
import { gateTitle } from '../../c/-ui/gate.tsx';
import { headTitle, ownTitle } from '../../../shell/title.ts';

// /post/<id>: one post, its actions and (lane D) its thread. The page is personal (the gate,
// a tombstone and the actions depend on who looks), so loadPost sets cache-control: no-store.
// The author's actions are plain form posts to this URL: 303 back to the page, or JSON once
// hydrated. Moderation is MODF's slot (-ui/actions/moderate.tsx), which posts elsewhere.

// ?removed=1 opens "Removed by moderators" (for a browser without JavaScript; the thread section reads it).
const Search = type({ 'error?': 'string', 'removed?': 'unknown' });
const Body = type({ intent: "'delete' | 'restore'" });

export const Route = createFileRoute('/post/$id/')({
  validateSearch: Search,
  loader: async ({ params }) => {
    const data = await loadPost({ data: { id: params.id } });
    if (!data) throw notFound();
    return data;
  },
  head: (context) => {
    const { loaderData } = context;
    return {
      meta:
        loaderData?.kind === 'gate'
          ? [...headTitle(context, 'communities', gateTitle(loaderData)), { name: 'robots', content: 'noindex' }]
          : ownTitle(context, loaderData && `${loaderData.post.title} | !${loaderData.post.community.handle}`),
      links: [
        { rel: 'stylesheet', href: postCss },
        { rel: 'stylesheet', href: gateCss },
      ],
    };
  },
  component: PostRoute,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!sameOrigin(request)) return forbidden();
        // The id goes into the Location header below: only a uuid does.
        if (!Uuid.allows(params.id)) return new Response(null, { status: 404 });
        const { session } = await formSession(request);
        const cookies = session?.setCookies ?? [];
        const back = `/post/${params.id}`;
        if (!session) return answer(request, cookies, { ok: false, reason: 'auth.required' }, back);
        const body = Body(await readForm(request));
        if (body instanceof type.errors) return answer(request, cookies, { ok: false, reason: 'target.not_found' }, back);
        const principal = principalOf(session.view);
        const outcome: Outcome = await {
          delete: () => deletePostAs(principal, params.id),
          restore: () => restorePostAs(principal, params.id),
        }[body.intent]();
        return answer(request, cookies, outcome, back);
      },
    },
  },
});

function PostRoute() {
  const data = Route.useLoaderData();
  const { error } = Route.useSearch();
  return <PostPage data={data} error={error} />;
}
