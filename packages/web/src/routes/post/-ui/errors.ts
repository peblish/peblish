import type { MessageKey } from '../../../i18n/translate.ts';

// The refusals and web-only codes the post page shows, each with an error.<code> message in
// i18n/posts.json. Anything else is 'generic'.
export const postErrors = [
  'auth.required',
  'auth.actor_deleted',
  'target.not_found',
  'target.deleted',
  'target.removed',
  'target.not_removed',
  'post.author_required',
  'post.not_deleted',
  'mod.moderator_required',
  'community.banned',
  'community.removed',
  'community.deleted',
  'generic',
  'network',
] as const;

export type PostError = (typeof postErrors)[number];

const known: ReadonlySet<string> = new Set(postErrors);

/** A code from the URL or the server, as one the page has a message for. */
export function asPostError(code: string | undefined | null): PostError | undefined {
  if (!code) return undefined;
  return known.has(code) ? (code as PostError) : 'generic';
}

export const errorKey = (code: PostError): MessageKey<'posts'> => `error.${code}`;
