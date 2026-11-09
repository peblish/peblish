import type { MessageKey } from '../../../../../i18n/translate.ts';

// The refusals and web-only codes the comment forms show, each with an error.<code> message in
// i18n/comments.json. Anything else is 'generic'.
export const commentErrors = [
  'auth.required',
  'auth.email_unverified',
  'auth.actor_deleted',
  'target.not_found',
  'target.deleted',
  'target.removed',
  'post.locked',
  'comment.depth_exceeded',
  'comment.author_required',
  'community.banned',
  'community.removed',
  'community.deleted',
  'invalid',
  'generic',
  'network',
] as const;

export type CommentError = (typeof commentErrors)[number];

const known: ReadonlySet<string> = new Set(commentErrors);

/** A code from the URL or the server, as one the page has a message for. */
export function asCommentError(code: unknown): CommentError | undefined {
  if (typeof code !== 'string' || code === '') return undefined;
  return known.has(code) ? (code as CommentError) : 'generic';
}

export const errorKey = (code: CommentError): MessageKey<'comments'> => `error.${code}`;
