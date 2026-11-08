// The plugin typings must reach every program that compiles this file (web's typecheck
// follows the import here), so they are referenced, not left to core's include glob.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./plugins.d.ts" />
import {
  RenderOptions,
  excerptLength as defaultExcerptLength,
  htmlMaxDepth,
  markdownMaxLength,
  type EmojiTable,
  type RenderedMarkdown,
} from '@peblish/schema/markdown';
import MarkdownIt, { type Env } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import { contexts, type RenderContext } from './context.ts';
import { emoji } from './emoji.ts';
import { highlight } from './highlight.ts';
import { images } from './images.ts';
import { mentions } from './mentions.ts';
import { sanitize, type SanitizeHooks } from './sanitize.ts';
import { spoiler } from './spoiler.ts';

// The peblish Markdown dialect (README.md in this folder has the table): markdown-it's
// default preset (CommonMark plus GFM tables and strikethrough) with Lemmy's options (no raw
// HTML, linkify without fuzzy links, typographer) and the plugin set lemmy-ui and PieFed
// share: footnotes, sub and superscript, spoilers. One instance serves every render; the
// per-call options travel in the env.
const md = new MarkdownIt('default', { html: false, linkify: true, typographer: true, maxNesting: htmlMaxDepth, highlight })
  .use(sub)
  .use(sup)
  .use(footnote)
  .use(spoiler)
  .use(images)
  .use(emoji)
  .use(mentions);
// Only scheme links (https://, mailto:) and angle autolinks, as Lemmy's server renders them.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });

export type RenderHooks = SanitizeHooks & {
  /** Shortcodes the `:name:` hook replaces (validate it with EmojiTable where it is loaded). */
  emoji?: EmojiTable;
};

/**
 * Renders a Markdown post or comment body: sanitised HTML (through the same allowlist as
 * remote HTML), a plain-text excerpt without spoilers, and the mentions and links found.
 * Relative links resolve against baseOrigin; images follow the image policy and the rewrite
 * hook; a source longer than maxLength is cut there.
 */
export function renderMarkdown(source: string, options: RenderOptions & RenderHooks): RenderedMarkdown {
  const { emoji: table = {}, rewriteImageUrl, ...data } = options;
  const checked = RenderOptions.assert(data);
  const base = new URL(checked.baseOrigin);
  const images = checked.images ?? 'inline';
  const maxLength = checked.maxLength ?? markdownMaxLength;
  const truncated = source.length > maxLength;

  // markdown-it-footnote prefixes its anchors with env.docId.
  const env: Env = checked.idPrefix ? { docId: checked.idPrefix } : {};
  const context: RenderContext = { origin: base.origin, host: base.hostname, images, emoji: table, mentions: [] };
  contexts.set(env, context);
  const html = md.render(truncated ? source.slice(0, maxLength) : source, env);

  const clean = sanitize(
    html,
    {
      baseUrl: base.origin,
      images,
      rewriteImageUrl,
      maxDepth: htmlMaxDepth,
      excerptLength: checked.excerptLength ?? defaultExcerptLength,
    },
    Number.MAX_SAFE_INTEGER,
  );
  return { ...clean, truncated, mentions: context.mentions };
}
