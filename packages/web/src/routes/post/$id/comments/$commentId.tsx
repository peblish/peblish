import { parseSort } from '@peblish/core/comments/sort';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { type } from 'arktype';
import gateCss from '../../../c/-ui/gate.css?url';
import postCss from '../../-ui/post.css?url';
import { loadPermalinkFn } from './-thread-fn.ts';
import { PermalinkPage } from './-ui/permalink-page.tsx';
import { gateTitle } from '../../../c/-ui/gate.tsx';
import { headTitle, ownTitle } from '../../../../shell/title.ts';

// /post/<id>/comments/<commentId>: the "Continue this thread" page, one comment and what is
// under it. The page is personal like the post's (the gate, tombstones and the author's forms
// depend on who looks), so the server function sets cache-control: no-store through pageSession.
// ?sort= picks the order of the replies and ?after= (a cursor the page handed out) the page of
// them; ?edit= opens the author's edit form and ?removed= the list of removed comments (for a browser without JavaScript); ?commentError= carries a refusal of a form without JavaScript, ?error= one of the NSFW gate's.

const Search = type({
  'sort?': 'unknown',
  'after?': 'unknown',
  'edit?': 'unknown',
  'removed?': 'unknown',
  'commentError?': 'unknown',
  'error?': 'unknown',
});

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
  head: (context) => {
    const { loaderData } = context;
    return {
      meta:
        loaderData?.kind === 'gate'
          ? [...headTitle(context, 'communities', gateTitle(loaderData)), { name: 'robots', content: 'noindex' }]
          : ownTitle(context, loaderData?.postTitle && `${loaderData.postTitle} | !${loaderData.communityHandle}`),
      links: [
        { rel: 'stylesheet', href: postCss },
        { rel: 'stylesheet', href: gateCss },
      ],
    };
  },
  component: PermalinkRoute,
});

function PermalinkRoute() {
  const data = Route.useLoaderData();
  const { id, commentId } = Route.useParams();
  const { error, edit } = Route.useSearch();
  // Keyed, so the router reusing this component for another comment's page keeps nothing of the last: a reply being typed, the comment it answers, folds, optimistic votes, a fetched page.
  return (
    <PermalinkPage
      key={`${id}/${commentId}`}
      data={data}
      postId={id}
      commentId={commentId}
      editing={edit !== undefined}
      error={typeof error === 'string' ? error : undefined}
    />
  );
}
