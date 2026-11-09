import { type } from 'arktype';
import { ActorKind, ApId, Uuid } from './ids.ts';

// Domain entities shared across packages. Each is the stable subset of its table's row:
// core asserts at compile time that the Drizzle row type satisfies it (entities.test-d.ts
// in core), so a table may grow columns without touching this file.
// Every federated entity carries the identity spine: uuidv7 id, immutable apId, local flag,
// instanceId and the raw JSON it was received as (null for content authored here).

const spine = {
  id: Uuid,
  apId: ApId,
  local: 'boolean',
  instanceId: Uuid,
  raw: 'unknown',
} as const;

export const Actor = type({
  ...spine,
  kind: ActorKind,
  /** preferredUsername. New local actors match [A-Za-z0-9_]; imported and remote ones may not. */
  name: 'string',
  displayName: 'string | null',
  summaryHtml: 'string | null',
  inboxUrl: 'string | null',
  sharedInboxUrl: 'string | null',
  sensitive: 'boolean',
  /** Group only: only moderators may post (lane F enforces it in authz). */
  postingRestrictedToMods: 'boolean',
  deletedAt: 'Date | null',
});
export type Actor = typeof Actor.infer;

export const Post = type({
  ...spine,
  authorId: Uuid,
  communityId: Uuid,
  title: 'string',
  url: 'string | null',
  bodyMd: 'string | null',
  contentHtml: 'string | null',
  sensitive: 'boolean',
  locked: 'boolean',
  publishedAt: 'Date',
  editedAt: 'Date | null',
  deletedAt: 'Date | null',
  removedAt: 'Date | null',
});
export type Post = typeof Post.infer;

/** Depth of a comment is the number of labels in its ltree path; 50 at most. */
export const MAX_COMMENT_DEPTH = 50;

export const Comment = type({
  ...spine,
  postId: Uuid,
  authorId: Uuid,
  parentId: Uuid.or('null'),
  /** ltree of comment ids from the top-level comment down to this one, dot-separated. */
  path: 'string',
  bodyMd: 'string | null',
  contentHtml: 'string | null',
  publishedAt: 'Date',
  editedAt: 'Date | null',
  deletedAt: 'Date | null',
  removedAt: 'Date | null',
});
export type Comment = typeof Comment.infer;

/** One row per voter and target. Changing direction replaces the row (its apId is immutable). */
export const Vote = type({
  ...spine,
  voterId: Uuid,
  postId: Uuid.or('null'),
  commentId: Uuid.or('null'),
  value: '1 | -1',
});
export type Vote = typeof Vote.infer;

export const ScanState = type("'pending' | 'clean' | 'quarantined' | 'blocked' | 'failed'");
export type ScanState = typeof ScanState.infer;

export const Media = type({
  id: Uuid,
  ownerId: Uuid.or('null'),
  kind: "'upload' | 'remote' | 'thumbnail'",
  storageKey: 'string | null',
  remoteUrl: 'string | null',
  mimeType: 'string | null',
  sha256: 'string | null',
  scanState: ScanState,
});
export type Media = typeof Media.infer;
