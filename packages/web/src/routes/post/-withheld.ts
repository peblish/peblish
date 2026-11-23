import { newObjectApId } from '@peblish/schema/actor-urls';
import type { ActorRef, CommentView, PostView } from '@peblish/schema/views';

// Who wrote what is gone, as the page sends it (browser-safe: the loaders map, the page reads).
// A deleted comment, and a post that is deleted or that a moderator removed, name their author
// only to that author and to the community's moderators and site admins. Everyone else gets
// `nobody` in the author's place, no badge, the object's local address instead of its own (a
// peer's can embed the handle).
// A comment a moderator removed keeps its author line, as the thread draws it, but goes without
// its own address too: its text is withheld, and a peer may still serve it there. A comment by
// someone the viewer blocks is sent as it is: only the viewer's own block hides its text.

const nobodyId = '00000000-0000-0000-0000-000000000000';

const nobody = (apId: string): ActorRef => ({
  id: nobodyId,
  apId,
  kind: 'Person',
  name: '',
  displayName: null,
  local: true,
  handle: '',
});

/** Whether the page was told who wrote this; when not, it draws no author line and no Block. */
export const authorWithheld = (author: Pick<ActorRef, 'id'>) => author.id === nobodyId;

/** Who may be told: the author and the moderators. `viewerId` is null when signed out. */
const told = (authorId: string, viewerId: string | null, moderator: boolean) => moderator || authorId === viewerId;

/** The post as the page sends it to this viewer. */
export function postAsShown(view: PostView, viewer: { id: string | null; moderator: boolean }, origin: string): PostView {
  if (!(view.deleted || view.removed) || told(view.author.id, viewer.id, viewer.moderator)) return view;
  const apId = newObjectApId(origin, 'post', view.id);
  return { ...view, apId, author: nobody(apId), authorBadge: null };
}

/** A comment as the thread sends it to this viewer. */
export function commentAsShown(view: CommentView, viewer: { id: string | null; moderator: boolean }, origin: string): CommentView {
  if (!(view.deleted || view.removed) || told(view.author.id, viewer.id, viewer.moderator)) return view;
  const apId = newObjectApId(origin, 'comment', view.id);
  return view.deleted ? { ...view, apId, author: nobody(apId), authorBadge: null } : { ...view, apId };
}

/** The word a tombstone's row prints (the thread's rule: both flags read as removed), for the reply bar to say the same. */
export const tombstoneWord = (comment: Pick<CommentView, 'removed' | 'deleted'>, labels: { removed: string; deleted: string }) =>
  comment.removed ? labels.removed : labels.deleted;

/**
 * How the reply bar names the comment it answers: a deleted one by the word its row prints, for
 * whoever is looking (the row draws no author then, for its author and staff too, who are told
 * it); any other, a removed-only one included, by its author's handle as `handle` formats it.
 */
export const replyTargetName = (
  comment: Pick<CommentView, 'removed' | 'deleted' | 'author'>,
  labels: { removed: string; deleted: string },
  handle: (raw: string) => string,
) => (comment.deleted ? tombstoneWord(comment, labels) : handle(comment.author.handle));
