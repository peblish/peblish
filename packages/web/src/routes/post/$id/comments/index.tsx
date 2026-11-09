import { createFileRoute, redirect } from '@tanstack/react-router';
import { handleCommentPost } from './-form.ts';

// POST /post/<id>/comments: the comment forms' endpoint (reply, edit, delete; -form.ts). It has
// no page of its own, so a GET goes to the post's.
export const Route = createFileRoute('/post/$id/comments/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/post/$id', params: { id: params.id } });
  },
  server: {
    handlers: {
      POST: ({ request, params }) => handleCommentPost(request, params.id),
    },
  },
});
