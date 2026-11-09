import { deletePostAs, restorePostAs } from '@peblish/core/posts/actions';
import { Uuid } from '@peblish/schema/ids';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { type } from 'arktype';
import { forbidden, formSession, principalOf, readForm, sameOrigin } from '../../../server/auth.ts';
import { loadPost } from '../-load.ts';
import { answer, type Outcome } from '../-form.ts';
import { PostPage } from '../-ui/post-page.tsx';
import postCss from '../-ui/post.css?url';

// /post/<id>: one post, its actions and (lane D) its thread. The page is personal (the gate,
// a tombstone and the actions depend on who looks), so loadPost sets cache-control: no-store.
// The author's actions are plain form posts to this URL: 303 back to the page, or JSON once
// hydrated. Moderation is MODF's slot (-ui/actions/moderate.tsx), which posts elsewhere.

const Search = type({ 'error?': 'string' });
const Body = type({ intent: "'delete' | 'restore'" });

export const Route = createFileRoute('/post/$id/')({
  validateSearch: Search,
  loader: async ({ params }) => {
    const data = await loadPost({ data: { id: params.id } });
    if (!data) throw notFound();
    return data;
  },
  head: ({ loaderData }) => ({
    meta: loaderData?.post.title ? [{ title: `${loaderData.post.title} | !${loaderData.post.community.handle}` }] : [],
    links: [{ rel: 'stylesheet', href: postCss }],
  }),
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
