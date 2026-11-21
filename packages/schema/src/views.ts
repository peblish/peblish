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

/** Another post named from this one: a series' previous or next part. */
export const PostRef = type({ id: Uuid, title: 'string' });
export type PostRef = typeof PostRef.infer;

/** Where a post sits in its author's series. `previous` and `next` skip parts the viewer may not see. */
export const SeriesPosition = type({
  id: Uuid,
  title: 'string | null',
  ordinal: 'number.integer >= 1',
  total: 'number.integer >= 1',
  previous: PostRef.or('null'),
  next: PostRef.or('null'),
});
export type SeriesPosition = typeof SeriesPosition.infer;

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
  // Optional until the readers fill them (Commons features).
  /** The absolute address of the discussion on this server. */
  'permalink?': 'string.url',
  /** The viewer saved the post (owner-only). */
  'saved?': 'boolean',
  /** The viewer follows the thread (owner-only). */
  'watching?': 'boolean',
  /** The post's place in a series, or null when it is in none. */
  'series?': SeriesPosition.or('null'),
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
  /** True when the viewer blocks the author (or their instance): the thread keeps the place, without the text. */
  'blocked?': 'boolean',
  // Optional until the readers fill them (Commons features).
  /** The absolute address of the comment's discussion on this server. */
  'permalink?': 'string.url',
  /** Arrived since the viewer's previous visit to the thread. */
  'isNew?': 'boolean',
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

// Commons view models. The fields added to views that live in core or web (the thread, the
// shell's community entries, the profile) are shapes here, optional until a reader fills them;
// the new pages' models are complete.

/** What a thread view adds for "new since your last visit"; a first visit sets the baseline and shows nothing as new. */
export const ThreadVisit = type({
  /** When the viewer last opened the thread; null on a first visit. */
  'previousVisitAt?': IsoDate.or('null'),
  'newCount?': 'number.integer >= 0',
});
export type ThreadVisit = typeof ThreadVisit.infer;

/** One community in the shell's sidebar. */
export const ShellCommunity = ActorRef.merge({
  /** 'none' for a signed-out visitor, whose sidebar lists local communities with no follow. */
  'followState?': "'none' | 'accepted' | 'pending'",
  'pinned?': 'boolean',
  /** The pin's place in the viewer's order; null when not pinned. */
  'pinPosition?': 'number.integer >= 0 | null',
  'iconUrl?': 'string | null',
});
export type ShellCommunity = typeof ShellCommunity.infer;

/** What a profile adds: the communities its subject moderates, verified on this server only. */
export const ProfileModerates = type({ 'moderates?': ActorRef.array() });
export type ProfileModerates = typeof ProfileModerates.infer;

/** The Saved page (owner-only), newest save first. */
export const SavedPost = PostView.merge({ savedAt: IsoDate });
export type SavedPost = typeof SavedPost.infer;
export const SavedPage = type({ items: SavedPost.array(), nextCursor: 'string | null' });
export type SavedPage = typeof SavedPage.infer;

/** Post search results. */
export const SearchResults = type({ query: 'string', items: PostView.array(), nextCursor: 'string | null' });
export type SearchResults = typeof SearchResults.infer;

/** A series part. A hidden or removed part is a numbered gap: it carries no other field, so nothing about the post leaks. */
export const SeriesPart = type({ '+': 'reject', ordinal: 'number.integer >= 1', state: "'visible'", post: PostView }).or({
  '+': 'reject',
  ordinal: 'number.integer >= 1',
  state: "'hidden' | 'removed'",
});
export type SeriesPart = typeof SeriesPart.infer;

/** The series page. */
export const SeriesPage = type({ id: Uuid, title: 'string | null', author: ActorRef, parts: SeriesPart.array() });
export type SeriesPage = typeof SeriesPage.infer;

/**
 * The report queue by community: the queue's existing filters apply first, and grouping and
 * counting cover only what the viewer may already see. Reports with no community (about a
 * person, or the admin-only categories) are one group with `community` null, for admins only.
 * `Row` is the queue's existing row (core's reports/read.ts).
 */
export type ReportQueueGroup<Row> = { community: ActorRef | null; openCount: number; rows: Row[] };

/** One row of the public Instances page: a peer this server currently federates with. */
export const InstanceRow = type({ domain: 'string', software: 'string | null' });
export type InstanceRow = typeof InstanceRow.infer;
