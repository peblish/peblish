import { type } from 'arktype';
import { ActorKind, ApId, IsoDate, Uuid } from './ids.ts';

// View models: what core read services hand to the web app and ui components render.
// JSON-safe (dates as ISO strings) so they cross server functions unchanged.

export const ActorRef = type({
  id: Uuid,
  apId: ApId,
  kind: ActorKind,
  name: 'string',
  displayName: 'string | null',
  local: 'boolean',
  /** name@host for remote actors, name for local ones. */
  handle: 'string',
});
export type ActorRef = typeof ActorRef.infer;

export const Counts = type({ upvotes: 'number.integer', downvotes: 'number.integer', comments: 'number.integer' });
export type Counts = typeof Counts.infer;

/** The badge beside an author's name: a site admin, or a moderator of the post's community. */
export const AuthorBadge = type("'admin' | 'moderator' | null");
export type AuthorBadge = typeof AuthorBadge.infer;

export const PostView = type({
  id: Uuid,
  apId: ApId,
  title: 'string',
  url: 'string | null',
  /** The link's media type when known (an image post), else null. */
  urlContentType: 'string | null',
  thumbnailUrl: 'string | null',
  /** Rendered body. Loaders fill it only on the post page; feeds leave it null and show `excerpt`. */
  contentHtml: 'string | null',
  /** Plain text for Card density, from the Markdown renderer's `excerpt`; null when there is no body. */
  excerpt: 'string | null',
  author: ActorRef,
  authorBadge: AuthorBadge,
  community: ActorRef,
  publishedAt: IsoDate,
  editedAt: IsoDate.or('null'),
  sensitive: 'boolean',
  nsfl: 'boolean',
  locked: 'boolean',
  featured: 'boolean',
  deleted: 'boolean',
  removed: 'boolean',
  counts: Counts,
  myVote: '-1 | 0 | 1',
});
export type PostView = typeof PostView.infer;

export const CommentView = type({
  id: Uuid,
  apId: ApId,
  postId: Uuid,
  parentId: Uuid.or('null'),
  depth: 'number.integer',
  contentHtml: 'string | null',
  author: ActorRef,
  authorBadge: AuthorBadge,
  publishedAt: IsoDate,
  editedAt: IsoDate.or('null'),
  deleted: 'boolean',
  removed: 'boolean',
  counts: Counts,
  myVote: '-1 | 0 | 1',
});
export type CommentView = typeof CommentView.infer;

export const CommunityView = type({
  actor: ActorRef,
  summaryHtml: 'string | null',
  sensitive: 'boolean',
  postingRestrictedToMods: 'boolean',
  subscribers: 'number.integer',
});
export type CommunityView = typeof CommunityView.infer;

/** One keyset page; `next` is an opaque cursor, null on the last page. */
export type Page<T> = { items: T[]; next: string | null };
