import { ActorKind, Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';

// A named fixture set: rows for the public tables (instances, actors, community languages,
// posts, comments, votes, follows) as JSON, written by tools/fixture-import from the federation corpus and loaded by
// load.ts. Ids are deterministic uuidv7s, so a set loads the same rows every time. Counters
// (upvotes, downvotes, comment_count, child_count) count the set's own votes and comments.
// No row carries `local`: the loader derives it from the instance the caller names local.

const date = type('string.date.iso.parse');
const optionalDate = date.or('null');
const text = type('string | null');

const content = {
  id: Uuid,
  instanceId: Uuid,
  apId: 'string.url',
  raw: 'unknown',
} as const;

export const FixtureInstance = type({
  id: Uuid,
  domain: 'string',
  origin: 'string.url',
  software: text,
  softwareVersion: text,
});

export const FixtureActor = type({
  ...content,
  kind: ActorKind,
  name: 'string',
  displayName: text,
  summaryHtml: text,
  summaryMd: text,
  inboxUrl: text,
  sharedInboxUrl: text,
  outboxUrl: text,
  followersUrl: text,
  featuredUrl: text,
  moderatorsUrl: text,
  iconUrl: text,
  bannerUrl: text,
  sensitive: 'boolean',
  nsfl: 'boolean',
  discoverable: 'boolean',
  indexable: 'boolean',
  bot: 'boolean',
  postingRestrictedToMods: 'boolean',
  postingWarning: text,
  publishedAt: optionalDate,
  updatedAt: optionalDate,
});

/** A community_languages row. */
export const FixtureCommunityLanguage = type({ communityId: Uuid, language: 'string' });

export const FixturePost = type({
  ...content,
  authorId: Uuid,
  communityId: Uuid,
  title: 'string',
  url: text,
  urlContentType: text,
  altText: text,
  thumbnailUrl: text,
  bodyMd: text,
  contentHtml: text,
  language: text,
  sensitive: 'boolean',
  nsfl: 'boolean',
  locked: 'boolean',
  featuredCommunity: 'boolean',
  upvotes: 'number.integer >= 0',
  downvotes: 'number.integer >= 0',
  commentCount: 'number.integer >= 0',
  publishedAt: date,
  editedAt: optionalDate,
  deletedAt: optionalDate,
  removedAt: optionalDate,
});

export const FixtureComment = type({
  ...content,
  postId: Uuid,
  authorId: Uuid,
  parentId: Uuid.or('null'),
  /** Comment ids from the top-level comment down; parents come before children in the set. */
  path: 'string',
  bodyMd: text,
  contentHtml: text,
  language: text,
  distinguished: 'boolean',
  upvotes: 'number.integer >= 0',
  downvotes: 'number.integer >= 0',
  /** Every comment below this one, at any depth, as Lemmy counts (lab-live has none two levels deep). */
  childCount: 'number.integer >= 0',
  publishedAt: date,
  editedAt: optionalDate,
  deletedAt: optionalDate,
  removedAt: optionalDate,
});

export const FixtureVote = type({
  ...content,
  voterId: Uuid,
  postId: Uuid.or('null'),
  commentId: Uuid.or('null'),
  value: '1 | -1',
});

export const FixtureFollow = type({
  id: Uuid,
  followerId: Uuid,
  followeeId: Uuid,
  apId: text,
  state: "'pending' | 'accepted'",
});

export const FixtureSet = type({
  name: 'string',
  description: 'string',
  /** The instance a caller would usually load as local (the spike's, for lab-live). */
  suggestedLocalDomain: text,
  instances: FixtureInstance.array(),
  actors: FixtureActor.array(),
  communityLanguages: FixtureCommunityLanguage.array(),
  posts: FixturePost.array(),
  comments: FixtureComment.array(),
  votes: FixtureVote.array(),
  follows: FixtureFollow.array(),
});
/** The set as stored (ISO strings); `FixtureSet.infer` is the parsed form (Dates). */
export type FixtureSetJson = typeof FixtureSet.inferIn;
export type FixtureSet = typeof FixtureSet.infer;
