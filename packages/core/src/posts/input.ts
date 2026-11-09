import { markdownMaxLength } from '@peblish/schema/markdown';
import { type } from 'arktype';

// What a person may send when they write or edit a post. Pure (ArkType only), so the composer
// can import the limits and run the same checks in the browser; the mutations assert again.

/** Characters (code points) in a title, counted after `normalizeTitle`. */
export const postTitleMaxLength = 200;
const linkMaxLength = 2000;
const altTextMaxLength = 1000;

/** A title is one line: runs of whitespace, newlines included, become one space. */
export const normalizeTitle = (title: string): string => title.replace(/\s+/g, ' ').trim();

const Title = type('string').narrow((title, ctx) => {
  const length = [...normalizeTitle(title)].length;
  return (length >= 1 && length <= postTitleMaxLength) || ctx.mustBe(`1 to ${postTitleMaxLength} characters`);
});

/** An http or https URL without credentials: javascript:, data: and the like never become a link. */
const Link = type('string').narrow((value, ctx) => {
  if (value.length > linkMaxLength) return ctx.mustBe(`at most ${linkMaxLength} characters`);
  const url = URL.parse(value);
  return (
    (url !== null && (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) ||
    ctx.mustBe('an http or https URL')
  );
});

const mediaType = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9*][a-z0-9!#$&^_.+*-]*$/i;

const fields = {
  title: Title,
  'url?': Link.or('null'),
  'bodyMd?': type(`string <= ${markdownMaxLength}`).or('null'),
  'sensitive?': 'boolean',
  /** Not safe for life, stronger than sensitive; it makes the post sensitive too. */
  'nsfl?': 'boolean',
  /** ISO 639 code, such as en. */
  'language?': type(/^[a-z]{2,3}$/).or('null'),
  // The link preview, filled by lane B2's fetchLinkPreview.
  'thumbnailUrl?': Link.or('null'),
  'urlContentType?': type('string <= 255').and(mediaType).or('null'),
  'altText?': type(`string <= ${altTextMaxLength}`).or('null'),
} as const;

/** A new post. `url` null or absent is a text post. */
export const NewPost = type(fields);
export type NewPost = typeof NewPost.infer;

/** An edit: only the fields present change (null clears a nullable one). */
export const PostEdit = NewPost.partial();
export type PostEdit = typeof PostEdit.infer;
