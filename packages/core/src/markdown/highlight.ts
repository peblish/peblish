import hljs from 'highlight.js/lib/common';
import type { MarkdownIt } from 'markdown-it';
import { contexts, type RenderContext } from './context.ts';

// Code highlighting for fenced blocks: a block whose language highlight.js knows (its common
// set, pure JavaScript) becomes hljs-* spans; anything else stays plain, escaped by
// markdown-it. No auto-detection, which is slow and often wrong. highlight.js is quadratic
// on some inputs (2,000 characters of `$` in Java take about 20 ms), so both limits below
// keep a render's highlighting time bounded.

/** Longer blocks stay plain. */
export const highlightBlockMaxLength = 2_000;
/** Characters highlighted per render; a block that would pass it stays plain. */
export const highlightRenderBudget = 8_000;

function highlightWithin(context: RenderContext, code: string, lang: string): string {
  const fits = code.length <= highlightBlockMaxLength && context.highlighted + code.length <= highlightRenderBudget;
  if (!lang || !fits || !hljs.getLanguage(lang)) return '';
  context.highlighted += code.length;
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}

/** The plugin: markdown-it's highlight option sees no env, so the fence rule hands it this render's context. */
export function highlight(md: MarkdownIt): void {
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, renderer) => {
    const context = env && contexts.get(env);
    const highlight = context ? (code: string, lang: string) => highlightWithin(context, code, lang) : null;
    return fence(tokens, idx, { ...options, highlight }, env, renderer);
  };
}
