import { newObjectApId } from '@peblish/schema/actor-urls';
import type { ActorRef, CommentView, PostView } from '@peblish/schema/views';

// Who wrote what is gone, as the page sends it (browser-safe: the loaders map, the page reads).
// A deleted comment, and a post that is deleted or that a moderator removed, name their author
// only to that author and to the community's moderators and site admins. Everyone else gets
// `nobody` in the author's place, no badge, the object's local address instead of its own (a
// peer's can embed the handle) and, for a post, no series to step to the author's other parts.
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
  const { series: _series, ...rest } = view;
  const apId = newObjectApId(origin, 'post', view.id);
  return { ...rest, apId, author: nobody(apId), authorBadge: null };
}

/** A comment as the thread sends it to this viewer. */
export function commentAsShown(view: CommentView, viewer: { id: string | null; moderator: boolean }, origin: string): CommentView {
  if (!(view.deleted || view.removed) || told(view.author.id, viewer.id, viewer.moderator)) return view;
  const apId = newObjectApId(origin, 'comment', view.id);
  return view.deleted ? { ...view, apId, author: nobody(apId), authorBadge: null } : { ...view, apId };
}
