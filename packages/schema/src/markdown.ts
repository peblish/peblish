import { type } from 'arktype';

// Contracts for c/markdown (lane MD): the data options of renderMarkdown and
// sanitizeRemoteHtml and what they return. The hooks (the emoji table and the image URL
// rewrite) are typed in core: the table is validated with EmojiTable where it is loaded,
// not on every render.

/** Lemmy 0.19's limit for a post body (POST_BODY_MAX_LENGTH), and the default render cap. */
export const markdownMaxLength = 50_000;
/** Remote HTML longer than this is cut before sanitising (Lemmy's highlighted code inflates it). */
export const remoteHtmlMaxLength = 500_000;
/** Elements nested deeper than this are unwrapped: their text stays, the tags go. */
export const htmlMaxDepth = 32;
/** Default length of the plain-text excerpt, in characters. */
export const excerptLength = 300;
/** Distinct mentions collected and linked per body; a new one past this many stays plain text. */
export const mentionMaxCount = 50;

/** How images appear: inline `<img>` (through the rewrite hook), or as links to the image. */
export const ImagePolicy = type("'inline' | 'link'");
export type ImagePolicy = typeof ImagePolicy.infer;

/** A custom emoji shown for `:shortcode:`. */
export const CustomEmoji = type({ url: 'string.url', 'alt?': 'string' });
export type CustomEmoji = typeof CustomEmoji.infer;
/** Shortcode (without colons) to Unicode text or a custom emoji image. */
export const EmojiTable = type({ '[string]': type('string').or(CustomEmoji) });
export type EmojiTable = typeof EmojiTable.infer;

const length = '0 < number.integer <= 10000000';

export const RenderOptions = type({
  /** Origin that relative links resolve against and mention links point to, such as https://feddit.com. */
  baseOrigin: 'string.url',
  /** Default 'inline'. */
  'images?': ImagePolicy,
  /** Source characters rendered (default markdownMaxLength); the rest is cut and `truncated` is set. */
  'maxLength?': length,
  'excerptLength?': '0 <= number.integer <= 10000',
  /** Namespaces footnote anchors, so several bodies on one page do not collide (a post or comment id). */
  'idPrefix?': /^[\w-]{1,64}$/,
});
export type RenderOptions = typeof RenderOptions.infer;

export const SanitizeOptions = type({
  /** The remote object's URL. Relative links resolve against it and must stay on its origin; without it they are dropped. */
  'baseUrl?': 'string.url',
  /** Default 'inline'. */
  'images?': ImagePolicy,
  /** Input characters sanitised (default remoteHtmlMaxLength); the rest is cut and `truncated` is set. */
  'maxLength?': length,
  /** Default htmlMaxDepth. */
  'maxDepth?': '0 < number.integer <= 100',
  'excerptLength?': '0 <= number.integer <= 10000',
});
export type SanitizeOptions = typeof SanitizeOptions.infer;

/** A `@user@host` or `!community@host` reference found in Markdown text. */
export const Mention = type({ kind: "'person' | 'community'", name: 'string', host: 'string' });
export type Mention = typeof Mention.infer;

export const SanitizedHtml = type({
  html: 'string',
  /** Plain text for previews and notifications, without spoiler bodies or footnotes. */
  excerpt: 'string',
  /** Absolute http(s) and mailto links, in order, without duplicates, mentions, hashtags or footnote anchors. */
  links: 'string[]',
  /** The input was longer than maxLength and was cut. */
  truncated: 'boolean',
});
export type SanitizedHtml = typeof SanitizedHtml.infer;

/** mentions: the distinct mentions in order of appearance, at most mentionMaxCount. */
export const RenderedMarkdown = SanitizedHtml.and({ mentions: Mention.array() });
export type RenderedMarkdown = typeof RenderedMarkdown.infer;
