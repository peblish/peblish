import hljs from 'highlight.js/lib/common';

/** Longer blocks stay plain: highlighting is the slowest part of a render. */
const highlightMaxLength = 20_000;

/**
 * markdown-it's highlight hook: a fenced block whose language highlight.js knows (its common
 * set, pure JavaScript) becomes hljs-* spans; anything else returns '' and markdown-it escapes
 * it. No auto-detection, which is slow and often wrong.
 */
export function highlight(code: string, lang: string): string {
  if (!lang || code.length > highlightMaxLength || !hljs.getLanguage(lang)) return '';
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}
