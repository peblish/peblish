import { type } from 'arktype';

// What a person may send when they write or edit a comment. Pure (ArkType only), so a form can
// import the limit; the mutations assert the input again.

/** The deepest level a comment can have: a reply to a comment at this level is refused. The database CHECK `comments_depth` is the backstop. */
export const maxCommentDepth = 50;

/** Characters (code points) in a comment's Markdown: Lemmy's limit for comments. Posts allow more (markdownMaxLength). */
export const commentMaxLength = 10_000;

/** A comment has something to read, and at most commentMaxLength characters. */
const Body = type('string').narrow((body, ctx) => {
  // A code point is at most two UTF-16 units, so a longer string cannot fit and is not spread.
  if (body.length > 2 * commentMaxLength || [...body].length > commentMaxLength)
    return ctx.mustBe(`at most ${commentMaxLength} characters`);
  return body.trim() !== '' || ctx.mustBe('not empty');
});

const fields = {
  bodyMd: Body,
  /** ISO 639 code, such as en. */
  'language?': type(/^[a-z]{2,3}$/).or('null'),
} as const;

/** A new comment. */
export const NewComment = type(fields);
export type NewComment = typeof NewComment.infer;

/** An edit replaces the body; the language is kept unless it is given. */
export const CommentEdit = type(fields);
export type CommentEdit = typeof CommentEdit.infer;
