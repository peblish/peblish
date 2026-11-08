import type { EmojiTable, ImagePolicy, Mention } from '@peblish/schema/markdown';
import type { Env } from 'markdown-it';

/** What one renderMarkdown call hands its plugins, keyed by that call's markdown-it env. */
export interface RenderContext {
  /** Canonical origin, such as https://feddit.com, and its host. */
  origin: string;
  host: string;
  images: ImagePolicy;
  emoji: EmojiTable;
  /** Filled by the mentions rule. */
  mentions: Mention[];
}

/** A WeakMap rather than fields on env, so the plugins read typed data without casts. */
export const contexts = new WeakMap<Env, RenderContext>();
