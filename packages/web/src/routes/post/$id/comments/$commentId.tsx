import { parseSort } from '@peblish/core/comments/sort';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { type } from 'arktype';
import postCss from '../../-ui/post.css?url';
import { loadPermalinkFn } from './-thread-fn.ts';
import { PermalinkPage } from './-ui/permalink-page.tsx';

// /post/<id>/comments/<commentId>: the "Continue this thread" page, one comment and what is
// under it. The page is personal like the post's (the gate, tombstones and the author's forms
// depend on who looks), so the server function sets cache-control: no-store through pageSession.
// ?sort= picks the order of the replies and ?after= (a cursor the page handed out) the page of
// them; ?commentError= carries a refusal of a form without JavaScript.

const Search = type({ 'sort?': 'unknown', 'after?': 'unknown', 'commentError?': 'unknown' });

export const Route = createFileRoute('/post/$id/comments/$commentId')({
  validateSearch: Search,
  loaderDeps: ({ search }) => ({ sort: parseSort(search.sort), after: typeof search.after === 'string' ? search.after : null }),
  loader: async ({ params, deps }) => {
    const data = await loadPermalinkFn({
      data: { postId: params.id, commentId: params.commentId, sort: deps.sort, ...(deps.after && { after: deps.after }) },
    });
    if (!data) throw notFound();
    return data;
  },
  head: ({ loaderData }) => ({
    meta: loaderData?.postTitle ? [{ title: `${loaderData.postTitle} | !${loaderData.communityHandle}` }] : [],
    links: [{ rel: 'stylesheet', href: postCss }],
  }),
  component: PermalinkRoute,
});

function PermalinkRoute() {
  const data = Route.useLoaderData();
  const { id, commentId } = Route.useParams();
  return <PermalinkPage data={data} postId={id} commentId={commentId} />;
}
