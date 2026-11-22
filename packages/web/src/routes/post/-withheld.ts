import type { ActorRef, CommentView, PostView } from '@peblish/schema/views';

// Who wrote what is gone, as the pages send it. Core's views carry the author on every post and
// comment, and a page sends its data with the HTML for hydration, so the loaders take the author
// out rather than only leave it unrendered (-load.ts for the post, $id/comments/-thread.ts for the
// thread). A tombstone (deleted, or removed by a moderator) keeps its flags, community, time and
// counts, but says nothing of its author: no id, name, handle or badge, and no address of its own,
// since a federated object's address can hold its author's handle. A post also loses its series,
// which would step to the author's other parts. Who is still told: the community's staff (its
// moderators and the site admins, `moderator`), who act on a tombstone, and for a post its author,
// who restores it from the page. A comment by someone the viewer blocks is sent as it is: only the
// viewer's own block hides its text. No imports beyond types: the pages read isWithheld too.

/** The author in a tombstone's place: no id, name, handle or address. */
export const withheldAuthor: ActorRef = {
  id: '00000000-0000-0000-0000-000000000000',
  apId: '',
  kind: 'Person',
  name: '',
  displayName: null,
  local: true,
  handle: '',
};

/** Whether a loader withheld this author: the page then draws no byline and no action that names them. */
export const isWithheld = (author: Pick<ActorRef, 'id'>): boolean => author.id === withheldAuthor.id;

const tombstone = (view: Pick<PostView | CommentView, 'deleted' | 'removed'>) => view.deleted || view.removed;

/** Whether the post's author goes to this viewer: a live post's always; a tombstone's only to staff and to its author. */
export const authorShown = (
  page: { view: Pick<PostView, 'deleted' | 'removed' | 'author'>; moderator: boolean },
  viewerId: string | null,
) => !tombstone(page.view) || page.moderator || viewerId === page.view.author.id;

/** The post as its page sends it to `viewerId`: core's view where authorShown holds, else without its author. */
export function postForViewer(page: { view: PostView; moderator: boolean }, viewerId: string | null): PostView {
  if (authorShown(page, viewerId)) return page.view;
  const { series: _series, ...rest } = page.view;
  return { ...rest, apId: '', author: withheldAuthor, authorBadge: null };
}

/** A comment as the thread sends it: a tombstone without its author, address or text, but to the community's staff. */
export function commentForViewer(view: CommentView, moderator: boolean): CommentView {
  if (!tombstone(view) || moderator) return view;
  return { ...view, apId: '', author: withheldAuthor, authorBadge: null, contentHtml: null };
}

/** The word a tombstone's row prints (the thread's rule: both flags read as removed), for the reply bar to say the same. */
export const tombstoneWord = (comment: Pick<CommentView, 'removed' | 'deleted'>, labels: { removed: string; deleted: string }) =>
  comment.removed ? labels.removed : labels.deleted;

/**
 * How the reply bar names the comment it answers: a tombstone by the word its row prints, for
 * whoever is looking (the row draws no author for one, staff included); any other by its author's
 * handle as `handle` formats it.
 */
export const replyTargetName = (
  comment: Pick<CommentView, 'removed' | 'deleted' | 'author'>,
  labels: { removed: string; deleted: string },
  handle: (raw: string) => string,
) => (tombstone(comment) || isWithheld(comment.author) ? tombstoneWord(comment, labels) : handle(comment.author.handle));
